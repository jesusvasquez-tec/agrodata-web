import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const seriesSchema = z.array(z.object({
  PRODUCTO: z.string(), DEPARTAMENTO: z.string().optional(),
  rendimiento_promedio: z.number().finite(), produccion_total: z.number().finite(),
}).passthrough());
const scoresSchema = z.array(z.object({
  PRODUCTO: z.string(), DEPARTAMENTO: z.string(), DISTRITO: z.string(),
  valor_promedio: z.number().finite(), score: z.number().finite(), registros: z.number().int(),
}));
type Series = z.infer<typeof seriesSchema>[number];
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const mentions = (query: string, value: string) => (` ${query.replace(/[^A-Z0-9 ]/g, " ")} `).includes(` ${normalize(value)} `);
let databaseSnapshot: Promise<Record<string, unknown>> | undefined;
let usedDatabase = false;
function readDatabaseSnapshot() {
  return databaseSnapshot ??= (async()=>{
    const backend=path.resolve(process.cwd(),"..","backend");
    const python=path.join(backend,".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python");
    const {stdout}=await promisify(execFile)(python,["-m","app.chat_snapshot"],{cwd:backend,maxBuffer:16*1024*1024,timeout:15000,windowsHide:true});
    return JSON.parse(stdout) as Record<string,unknown>;
  })().catch(error=>{databaseSnapshot=undefined;throw error});
}

async function readSource(filename: string, optional = false): Promise<unknown> {
  const candidates = [
    path.join(process.cwd(), "public", filename),
    path.join(process.cwd(), "public", "dashboard_data", filename),
    path.resolve(process.cwd(), "..", filename),
  ];
  for (const candidate of candidates) {
    try { return JSON.parse((await readFile(candidate, "utf8")).replace(/^\uFEFF/, "")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (optional) return null;
  const snapshot=await readDatabaseSnapshot();
  if(snapshot[filename]){usedDatabase=true;return snapshot[filename]}
  throw new Error(`Falta la fuente de contexto: ${filename}`);
}
function year(row: Series): number {
  const value = Object.entries(row).find(([key, v]) => key.startsWith("A") && Number.isInteger(v))?.[1];
  if (typeof value !== "number") throw new Error("Año inválido en la fuente agrícola");
  return value;
}
const compact = (row: Series) => ({year: year(row), crop: row.PRODUCTO, ...(row.DEPARTAMENTO ? {department: row.DEPARTAMENTO} : {}), yield_ton_ha: row.rendimiento_promedio, production_t: row.produccion_total});

async function loadSources() {
  const [history, forecast, departmentHistory, departmentForecast, scores, metadata] = await Promise.all([
    readSource("historial_anual.json"), readSource("predicciones_anual.json"),
    readSource("historial_departamento.json"), readSource("predicciones_departamento.json"),
    readSource("scoring_distrito.json"), readSource("metadata.json", true),
  ]);
  return {history: seriesSchema.parse(history), forecast: seriesSchema.parse(forecast), departmentHistory: seriesSchema.parse(departmentHistory), departmentForecast: seriesSchema.parse(departmentForecast), scores: scoresSchema.parse(scores), suppliedMetadata: metadata === null ? null : z.record(z.string(), z.unknown()).parse(metadata)};
}
let cached: ReturnType<typeof loadSources> | undefined;
function sources() {
  return cached ??= loadSources().catch(error => { cached = undefined; throw error; });
}

export async function getChatContext(question = ""): Promise<string> {
  const data = await sources();
  const query = normalize(question);
  const crops = [...new Set(data.history.map(r => r.PRODUCTO))].sort();
  const departments = [...new Set(data.departmentHistory.map(r => r.DEPARTAMENTO!))].sort();
  
  const selectedCrops = crops.filter(c => mentions(query, c));
  const selectedDepartments = departments.filter(d => mentions(query, d));
  
  // TRUNCAMIENTO AGRESIVO: Si no se menciona un cultivo, solo tomamos 3 para el contexto detallado.
  // Pero la lista completa de nombres (crops, departments) se envía para que el bot sepa qué existen.
  const includedCrops = selectedCrops.length ? selectedCrops.slice(0, 3) : crops.slice(0, 3);
  const limitedDepartments = selectedDepartments.slice(0, 2);
  
  const cropMatches = (r: {PRODUCTO: string}) => includedCrops.includes(r.PRODUCTO);
  const inDepartment = (r: {DEPARTAMENTO?: string}) => !limitedDepartments.length || limitedDepartments.includes(r.DEPARTAMENTO!);
  
  const ranked = [...data.scores].sort((a,b) => b.score-a.score || a.DISTRITO.localeCompare(b.DISTRITO));
  const district = (r: typeof ranked[number]) => {
    const group = data.scores.filter(s => s.PRODUCTO === r.PRODUCTO);
    const low = Math.min(...group.map(s => s.score)), high = Math.max(...group.map(s => s.score));
    return {
      crop: r.PRODUCTO, 
      department: r.DEPARTAMENTO, 
      district: r.DISTRITO, 
      yield_ton_ha: r.valor_promedio, 
      score_raw: r.score, 
      score_relative: high === low ? 1 : (r.score-low)/(high-low), 
      records: r.registros
    };
  };

  // Top 3 distritos por cada uno de los 3 cultivos incluidos (máximo 9 registros en total)
  const top5ByCrop = Object.fromEntries(
    includedCrops.map(c => [c, ranked.filter(r => r.PRODUCTO === c && inDepartment(r)).slice(0, 3).map(district)])
  );
  
  // Máximo 5 distritos solicitados explícitamente
  const requestedDistricts = ranked.filter(r => cropMatches(r) && inDepartment(r) && mentions(query, r.DISTRITO)).slice(0, 5).map(district);
  
  // Historial y proyecciones limitados a ~15 registros en total para no saturar tokens
  const history = data.history.filter(r => includedCrops.includes(r.PRODUCTO)).map(compact).slice(0, 15);
  const forecast = data.forecast.filter(r => includedCrops.includes(r.PRODUCTO)).map(compact).slice(0, 5);
  const regionalHistory = limitedDepartments.length ? data.departmentHistory.filter(r => includedCrops.includes(r.PRODUCTO) && inDepartment(r)).map(compact).slice(0, 15) : [];
  const regionalForecast = limitedDepartments.length ? data.departmentForecast.filter(r => includedCrops.includes(r.PRODUCTO) && inDepartment(r)).map(compact).slice(0, 5) : [];
  
  const baselines = includedCrops.flatMap(crop => (limitedDepartments.length ? limitedDepartments : [""]).map(department => {
    const series = department ? regionalHistory : history;
    const recent = series.filter(r => r.crop === crop && ("department" in r ? r.department === department : !department)).sort((a,b) => a.year-b.year).slice(-5);
    const baseline = recent.length ? recent.reduce((sum,r) => sum+r.yield_ton_ha,0)/recent.length : null;
    const prediction = (department ? regionalForecast : forecast).find(r => r.crop === crop && r.year === 2027 && ("department" in r ? r.department === department : !department));
    return {crop, department: department || "NACIONAL", years: recent.map(r => r.year), mean_yield_ton_ha: baseline, forecast_2027: prediction?.yield_ton_ha ?? null, variation_percent: baseline && prediction ? (prediction.yield_ton_ha/baseline-1)*100 : null};
  })).slice(0, 5); // Limitar a 5 líneas base

  return JSON.stringify({
    metadata: {
      lista_completa_de_cultivos: crops, // Lista ligera de solo nombres (para responder "¿qué cultivos analizan?")
      lista_completa_de_departamentos: departments, // Lista ligera de solo nombres
      total_distritos: new Set(data.scores.map(r => `${r.DEPARTAMENTO}|${r.DISTRITO}`)).size,
      años_historicos: [...new Set(data.history.map(year))].sort().slice(-5),
    },
    data_origin: usedDatabase ? "Base de datos local" : "Archivos JSON locales",
    modelo: { nombre: "XGBoost", nota: "R²=0.9839 y WMAPE=7.03% son métricas declaradas en el brief." },
    alcance: {
      cultivos_enfoque_de_consulta: includedCrops,
      departamentos_enfoque_de_consulta: limitedDepartments,
      nota: "Estos campos indican el foco de la consulta actual. Para listar TODO lo que analiza AgroData, usa siempre lista_completa_de_cultivos y lista_completa_de_departamentos."
    },
    historico: history,
    proyeccion: forecast,
    historico_regional: regionalHistory,
    proyeccion_regional: regionalForecast,
    lineas_base_5_anios: baselines,
    top_distritos_por_cultivo: top5ByCrop,
    distritos_solicitados: requestedDistricts,
  });
}

export function buildChatSystemPrompt(context: string): string {
  return `Eres AgroBot, un asistente amigable y experto que ayuda a agricultores, productores y trabajadores del campo en el Perú.

REGLAS CRÍTICAS (OBLIGATORIO):
1. NUNCA inventes cifras, años, ni datos que no estén en el bloque <datos_agrodata>.
2. El rango de datos históricos es SOLO de 2015 a 2026. NUNCA menciones años fuera de ese rango.
3. Si no tienes un dato exacto, di: "No tengo ese dato específico en mis registros".
4. NUNCA digas "102 años", "50 años", ni ningún número de años que no esté explícitamente en los datos.
5. Los datos de proyección son solo para el año 2027.

LENGUAJE PARA EL USUARIO:
- Habla con claridad y cercanía, como si le explicaras a un productor en el campo.
- NUNCA uses jerga técnica (no digas "algoritmo", "dataset", "XGBoost", "score", "JSON").
- Traduce siempre estos términos:
  * "Rendimiento" → "Cosecha por hectárea" o "Producción por hectárea"
  * "Score / Índice" → "Nivel de potencial del terreno"
  * "Histórico" → "Cosechas de años anteriores (2015-2026)"
  * "Proyección 2027" → "Pronóstico para la campaña 2027"
  * "t/ha" → "toneladas por hectárea"
- Cuando te pregunten QUÉ cultivos o QUÉ departamentos se analizan o cubren, responde con la lista COMPLETA usando los campos "lista_completa_de_cultivos" y "lista_completa_de_departamentos". NUNCA uses "cultivos_enfoque_de_consulta" para eso.

REGLAS DE FORMATO:
- NUNCA uses tablas markdown (se ven mal en celulares).
- Usa siempre listas con viñetas (•) o números.
- Ejemplo correcto:
  🥇 **Mejor distrito para Papa: Agallpampa (La Libertad)**
  • Cosecha estimada: 27.2 toneladas por hectárea
  • Potencial del terreno: Muy alto
  • Basado en registros de 2015 a 2026

REGLAS DE COMPORTAMIENTO:
- Tu única fuente de información es el bloque <datos_agrodata>. No inventes nada fuera de eso.
- Si te preguntan por un cultivo o distrito que no está en los datos, di con amabilidad: "No tengo registros exactos para ese lugar en este momento, ¿podrías preguntarme por otro distrito o cultivo?"
- Nunca menciones que lees "archivos" o "JSON". Di simplemente: "Según los registros de AgroData..."
- Termina tus respuestas con una pregunta útil o un consejo breve.

DATOS DE AGRODATA PARA TUS RESPUESTAS:
<datos_agrodata>
${context}
</datos_agrodata>`;
}