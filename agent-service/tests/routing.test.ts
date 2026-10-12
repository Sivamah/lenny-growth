import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeTurn, type HistoryItem } from "../src/routing.ts";

describe("routeTurn", () => {
  describe("General conversation scenarios", () => {
    it("routes general productivity/procrastination message to 'general'", () => {
      const prompt =
        "Hey! I've been trying to improve my productivity, but I often procrastinate and end up rushing my work at the last minute. Can you suggest a simple daily routine that helps me stay focused without feeling stressed?";
      const decision = routeTurn(prompt);
      assert.equal(decision.route, "general");
    });

    it("routes Test A prompt to 'general'", () => {
      const decision = routeTurn("How can I stop procrastinating and build a realistic daily routine?");
      assert.equal(decision.route, "general");
    });

    it("routes Test B Java programming question to 'general'", () => {
      const decision = routeTurn("Explain the difference between an array and an ArrayList in Java.");
      assert.equal(decision.route, "general");
    });

    it("routes timetable planning to 'general'", () => {
      const decision = routeTurn("Help me plan my college timetable.");
      assert.equal(decision.route, "general");
    });

    it("routes joke request to 'general'", () => {
      const decision = routeTurn("Tell me a joke.");
      assert.equal(decision.route, "general");
    });

    it("routes 3 ways to improve focus to 'general'", () => {
      const decision = routeTurn("Give me three ways to improve my focus.");
      assert.equal(decision.route, "general");
    });

    it("routes casual greetings to 'general'", () => {
      const decision = routeTurn("Hello!");
      assert.equal(decision.route, "general");
    });
  });

  describe("Transcript-specific scenarios", () => {
    it("routes explicit guest question (Jason Cohen) to 'transcript'", () => {
      const decision = routeTurn("What did Jason Cohen say about pricing when a product stops growing?");
      assert.equal(decision.route, "transcript");
      assert.match(decision.reason, /jason cohen/i);
    });

    it("routes guest surname match (Elena Verna) to 'transcript'", () => {
      const decision = routeTurn("What does Verna think about freemium?");
      assert.equal(decision.route, "transcript");
    });

    it("routes explicit podcast mention to 'transcript'", () => {
      const decision = routeTurn("What does Lenny's podcast say about distribution?");
      assert.equal(decision.route, "transcript");
    });

    it("routes podcast summary request to 'transcript'", () => {
      const decision = routeTurn("Summarize the episode about product growth.");
      assert.equal(decision.route, "transcript");
    });

    it("routes guest comparison request to 'transcript'", () => {
      const decision = routeTurn("Compare what two guests said about retention.");
      assert.equal(decision.route, "transcript");
    });

    it("routes unsupported podcast question to 'transcript'", () => {
      const decision = routeTurn("What did Lenny's podcast say about quantum computing algorithms?");
      assert.equal(decision.route, "transcript");
    });
  });

  describe("Follow-up scenarios", () => {
    const history: HistoryItem[] = [
      {
        role: "user",
        content: "What did Jason Cohen say about pricing when a product stops growing?",
      },
      {
        role: "assistant",
        content:
          "Jason Cohen emphasizes looking at whether pricing is too low or preventing expansion...",
      },
    ];

    it("routes Test D follow-up asking for practical examples to 'follow_up'", () => {
      const decision = routeTurn("Can you give me three practical examples of applying that advice?", history);
      assert.equal(decision.route, "follow_up");
    });

    it("routes follow-up asking for 7-day plan based on that advice to 'follow_up'", () => {
      const decision = routeTurn("Turn those suggestions into a 7-day action plan.", history);
      assert.equal(decision.route, "follow_up");
    });

    it("routes follow-up asking to elaborate on first point to 'follow_up'", () => {
      const decision = routeTurn("Explain the first point in more detail.", history);
      assert.equal(decision.route, "follow_up");
    });

    it("routes to 'transcript' if follow-up explicitly mentions a new guest", () => {
      const decision = routeTurn("What did Brian Halligan say about that?", history);
      assert.equal(decision.route, "transcript");
    });
  });
});
