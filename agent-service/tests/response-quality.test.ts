import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeTurn, type HistoryItem } from "../src/routing.ts";
import {
  extractConstraints,
  validateResponseAgainstConstraints,
  buildConstraintEnforcementPrompt,
  buildCorrectivePrompt,
} from "../src/constraints.ts";

describe("Response Quality and Instruction Following Regression Suite (12 Scenarios)", () => {
  // Scenario 1: Normal business advice
  describe("Scenario 1: Normal business advice", () => {
    it("routes general business advice to 'general' without searching transcripts", () => {
      const prompt = "How should a B2B SaaS startup think about customer onboarding in the first 90 days?";
      const decision = routeTurn(prompt);
      assert.equal(decision.route, "general");
    });

    it("does not detect false constraints on normal advice queries", () => {
      const prompt = "How should a B2B SaaS startup think about customer onboarding in the first 90 days?";
      const constraints = extractConstraints(prompt);
      assert.equal(constraints.hasConstraints, false);
      assert.equal(constraints.maxHours, null);
      assert.equal(constraints.maxBudget, null);
    });
  });

  // Scenario 2: Follow-up context retention
  describe("Scenario 2: Follow-up context retention", () => {
    it("routes follow-up referencing previous turn to 'follow_up' so history is reasoned over without tools", () => {
      const history: HistoryItem[] = [
        { role: "user", content: "How can I set up customer feedback loops for a coffee shop?" },
        { role: "assistant", content: "1. Place QR code feedback cards at tables. 2. Ask baristas to record verbal comments." },
      ];
      const followUp = "Can you turn that advice into a 3-step action plan for next week?";
      const decision = routeTurn(followUp, history);
      assert.equal(decision.route, "follow_up");
    });
  });

  // Scenario 3: A user correcting a previous answer
  describe("Scenario 3: User correcting a previous answer", () => {
    it("detects correction signals and requires acknowledgment", () => {
      const prompt = "That's incorrect. I don't have a team of 5 people, I am working completely alone. Please adjust the plan.";
      const constraints = extractConstraints(prompt);
      assert.equal(constraints.isCorrection, true);

      // Response that ignores correction
      const unacknowledged = "Here is a plan: 1. Assign two members to outreach and three to design.";
      const invalid = validateResponseAgainstConstraints(unacknowledged, constraints);
      assert.equal(invalid.pass, false);
      assert.ok(invalid.issues.some((i) => i.toLowerCase().includes("acknowledge")));

      // Response that admits and corrects
      const acknowledged = "You're right, I apologize for that mistake. Since you are working completely alone, here is a solo founder plan:";
      const valid = validateResponseAgainstConstraints(acknowledged, constraints);
      assert.equal(valid.pass, true);
    });
  });

  // Scenario 4: Strict 60-hour time limit
  describe("Scenario 4: Strict 60-hour time limit", () => {
    it("extracts 60 hours constraint and rejects responses with > 60 hours total", () => {
      const prompt = "Give me a 30-day plan. I have a strict 60-hour limit in total (2 hours per day). Allocate hours to each activity and show the total.";
      const constraints = extractConstraints(prompt);
      assert.equal(constraints.maxHours, 60);

      // Over-allocated draft
      const overPlan = `
Here is your plan:
- Customer discovery: 25 hours
- Building mockups: 20 hours
- In-person visits: 25 hours
Total: 60 hours.
`;
      const invalid = validateResponseAgainstConstraints(overPlan, constraints);
      assert.equal(invalid.pass, false);
      assert.ok(invalid.issues.some((i) => i.includes("70 hours") && i.includes("exceeds the limit of 60 hours")));

      // Compliant draft
      const compliantPlan = `
Here is your plan:
- Customer discovery: 20 hours
- Creating paper mockups: 10 hours
- In-person salon visits: 20 hours
Total hours allocated: 50 hours (under the 60-hour limit).
`;
      const valid = validateResponseAgainstConstraints(compliantPlan, constraints);
      assert.equal(valid.pass, true);
    });
  });

  // Scenario 5: Strict monetary budget
  describe("Scenario 5: Strict monetary budget", () => {
    it("extracts budget and validates cost compliance", () => {
      const prompt = "Suggest marketing ideas for my local bakery with a strict budget of ₹10,000. Do not spend more.";
      const constraints = extractConstraints(prompt);
      assert.equal(constraints.maxBudget?.amount, 10000);
      assert.equal(constraints.maxBudget?.currency, "₹");

      const compliant = "All suggested steps are organic: in-person flyers (₹2,000) and sample tastings (₹3,000), totaling ₹5,000.";
      const valid = validateResponseAgainstConstraints(compliant, constraints);
      assert.equal(valid.pass, true);
    });
  });

  // Scenario 6: Unimplemented feature
  describe("Scenario 6: Unimplemented feature handling", () => {
    it("detects unbuilt product status and rejects claims of working demos or free trials", () => {
      const prompt = "I have an AI idea for salons, but have not built the product yet. How do I get my first customer?";
      const constraints = extractConstraints(prompt);
      assert.equal(constraints.unbuiltProduct, true);

      const badResponse = "Offer them a 14-day free trial of your software and give a live software demo.";
      const invalid = validateResponseAgainstConstraints(badResponse, constraints);
      assert.equal(invalid.pass, false);
      assert.ok(invalid.issues.some((i) => i.includes("unbuilt product")));

      const goodResponse = "Since the product is not yet built, conduct problem discovery interviews with salon owners, show paper mockups, and deliver the scheduling manually as a concierge.";
      const valid = validateResponseAgainstConstraints(goodResponse, constraints);
      assert.equal(valid.pass, true);
    });
  });

  // Scenario 7: Normal programming question (no retrieval)
  describe("Scenario 7: Normal programming question (no transcript retrieval)", () => {
    it("routes Java, Python, and data structure queries directly to general", () => {
      assert.equal(routeTurn("Explain the difference between an array and an ArrayList in Java.").route, "general");
      assert.equal(routeTurn("How do I implement a binary search tree in Python?").route, "general");
      assert.equal(routeTurn("What is the time complexity of quicksort?").route, "general");
    });
  });

  // Scenario 8: Transcript-specific question (retrieval & citations)
  describe("Scenario 8: Transcript-specific question (retrieval & citations)", () => {
    it("routes explicit guest or podcast query to transcript", () => {
      const guestQuery = routeTurn("What did Jason Cohen say about pricing when a product stops growing?");
      assert.equal(guestQuery.route, "transcript");

      const podcastQuery = routeTurn("What does Lenny's podcast say about PMF benchmarks?");
      assert.equal(podcastQuery.route, "transcript");
    });
  });

  // Scenario 9: Session isolation
  describe("Scenario 9: Session isolation between different conversations", () => {
    it("ensures prompt constraints from one session do not pollute another", () => {
      const sessionAPrompt = "I have a budget of ₹10,000 and 60 hours total for a salon app.";
      const constraintsA = extractConstraints(sessionAPrompt);
      assert.equal(constraintsA.maxHours, 60);
      assert.equal(constraintsA.maxBudget?.amount, 10000);

      const sessionBPrompt = "How do I write unit tests in TypeScript?";
      const constraintsB = extractConstraints(sessionBPrompt);
      assert.equal(constraintsB.hasConstraints, false);
      assert.equal(constraintsB.maxHours, null);
      assert.equal(constraintsB.maxBudget, null);
    });
  });

  // Scenario 10: Long user message with preserved final instructions
  describe("Scenario 10: Long user message with preserved final instructions", () => {
    it("preserves final instructions at the end of long prompts", () => {
      const longContext = "A".repeat(2500);
      const fullPrompt = `${longContext}\n\nFinal instruction: Allocate exactly 30 hours and limit budget to $500.`;
      const constraints = extractConstraints(fullPrompt);
      assert.equal(constraints.maxHours, 30);
      assert.equal(constraints.maxBudget?.amount, 500);
      assert.equal(constraints.maxBudget?.currency, "$");

      const enforced = buildConstraintEnforcementPrompt(fullPrompt, constraints);
      assert.ok(enforced.includes("strict total limit of 30 hours"));
      assert.ok(enforced.includes("Total spending must not exceed $500"));
    });
  });

  // Scenario 11: Contradiction correction
  describe("Scenario 11: Contradiction correction", () => {
    it("flags contradiction challenges and guides model to rectify", () => {
      const prompt = "Your previous answer contradicted your earlier recommendation. You previously said X, now you said Y. Please clarify which is correct.";
      const constraints = extractConstraints(prompt);
      assert.equal(constraints.isCorrection, true);

      const corrective = buildConstraintEnforcementPrompt(prompt, constraints);
      assert.ok(corrective.includes("MISTAKE ACKNOWLEDGMENT"));
    });
  });

  // Scenario 12: Plan exceeding constraints auto-revised
  describe("Scenario 12: Plan exceeding constraints auto-revised", () => {
    it("generates an actionable corrective retry prompt when constraints are violated", () => {
      const prompt = "Give me a 30-day plan within 60 hours total for an unbuilt salon app.";
      const constraints = extractConstraints(prompt);
      const violatingDraft = `
- Market research: 30 hours
- Building prototype: 25 hours
- Customer demos: 20 hours
Total: 60 hours.
Offer customers a 14-day free trial.
`;
      const validation = validateResponseAgainstConstraints(violatingDraft, constraints);
      assert.equal(validation.pass, false);
      assert.equal(validation.issues.length >= 2, true);

      const retryPrompt = buildCorrectivePrompt(prompt, validation.issues, constraints);
      assert.ok(retryPrompt.includes("constraint violations"));
      assert.ok(retryPrompt.includes("exceeds the limit of 60 hours"));
      assert.ok(retryPrompt.includes("unbuilt product"));
    });
  });
});
