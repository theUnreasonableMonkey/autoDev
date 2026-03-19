import Anthropic from "@anthropic-ai/sdk";
import type { GitHubIssue } from "../machine/context.js";

const DELEGATE_SYSTEM_PROMPT = `You are an AI assistant helping to answer questions during automated development.
A coding AI is implementing a GitHub issue and has a question.
Based on the issue context and the question, choose the best answer from the options provided.

Respond with ONLY the exact label text of your chosen option. Nothing else.
If you are not confident in the answer, respond with exactly: __UNSURE__`;

/**
 * Tier 2: Ask an AI delegate to answer the question using project context.
 * Returns the chosen option label, or null if the delegate is unsure.
 */
export async function askDelegate(
  question: string,
  options: Array<{ label: string; description: string }>,
  issue: GitHubIssue,
  apiKey: string,
): Promise<string | null> {
  try {
    const client = new Anthropic({ apiKey });

    const prompt = [
      `Issue #${issue.number}: ${issue.title}`,
      issue.body ? `\nIssue body: ${issue.body.slice(0, 1000)}` : "",
      `\nQuestion: ${question}`,
      "\nOptions:",
      ...options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`),
      "\nChoose the best option. Respond with ONLY the label text.",
    ].join("\n");

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: DELEGATE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (!content || content.type !== "text") return null;

    const answer = content.text.trim();
    if (answer === "__UNSURE__") return null;

    // Verify the answer matches one of the options
    const match = options.find(
      (o) => o.label.toLowerCase() === answer.toLowerCase(),
    );
    return match ? match.label : null;
  } catch {
    return null;
  }
}
