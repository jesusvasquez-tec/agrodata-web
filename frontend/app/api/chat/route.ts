import { createChatHandler } from "@/lib/chat-handler";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = createChatHandler({
  onError: (error) => {
    console.error("[chat] Error real:", error);
  },
});
