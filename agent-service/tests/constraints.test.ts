import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractConstraints,
  validateResponseAgainstConstraints,
  buildConstraintEnforcementPrompt,
  buildCorrectivePrompt,
} from "../src/constraints.ts";

test("extractConstraints: extracts 60 hours from total available time", () => {
  const prompt =
    "- Business idea: AI salon platform\n- Budget: ₹10,000\n- Available time: 2 hours per day for 30 days.\n- Total available time: 60 hours.\n- Goal: find first paying customer without building the complete product.";
  const c = extractConstraints(prompt);
  assert.equal(c.hasConstraints, true);
  assert.equal(c.maxHours, 60);
  assert.equal(c.maxBudget?.amount, 10000);
  assert.equal(c.maxBudget?.currency, "₹");
  assert.equal(c.unbuiltProduct, true);
  assert.equal(c.isCorrection, false);
});

test("extractConstraints: calculates hours from hours per day and days", () => {
  const prompt = "I have 3 hours per day for 14 days to test my startup idea. Budget: $500.";
  const c = extractConstraints(prompt);
  assert.equal(c.hasConstraints, true);
  assert.equal(c.maxHours, 42);
  assert.equal(c.maxBudget?.amount, 500);
  assert.equal(c.maxBudget?.currency, "$");
});

test("extractConstraints: extracts strict 60-hour limit and correction", () => {
  const prompt =
    "Your previous plan exceeded my 60-hour limit. I have only 60 hours in total and have not built the product. Explain how I can find my first paying salon customer without spending money on graphic design or pretending that unfinished features work.";
  const c = extractConstraints(prompt);
  assert.equal(c.hasConstraints, true);
  assert.equal(c.maxHours, 60);
  assert.equal(c.unbuiltProduct, true);
  assert.equal(c.isCorrection, true);
  assert.ok(c.negativeDirectives.length > 0);
});

test("extractConstraints: returns hasConstraints=false for general questions", () => {
  const prompt = "How can I stop procrastinating while preparing for college exams?";
  const c = extractConstraints(prompt);
  assert.equal(c.hasConstraints, false);
  assert.equal(c.maxHours, null);
  assert.equal(c.maxBudget, null);
  assert.equal(c.unbuiltProduct, false);
  assert.equal(c.isCorrection, false);
});

test("extractConstraints: returns hasConstraints=false for programming questions", () => {
  const prompt = "Explain the difference between an array and an ArrayList in Java.";
  const c = extractConstraints(prompt);
  assert.equal(c.hasConstraints, false);
});

test("validateResponseAgainstConstraints: passes plan that respects 60-hour limit and concierge testing", () => {
  const constraints = extractConstraints(
    "Plan for 60 hours total, budget ₹10,000, without building the product. Your previous plan exceeded my limit.",
  );
  const response = `I apologize for the previous plan exceeding your 60-hour limit. Here is a revised plan within ₹10,000:

Activity 1: Discovery Interviews (10 hours)
Activity 2: Manual Concierge Testing (15 hours)
Activity 3: Clickable Mockup (10 hours)
Activity 4: Follow-up & Closing (15 hours)

Total Hours: 50 hours
Total Cost: ₹2,000 for local travel.`;

  const v = validateResponseAgainstConstraints(response, constraints);
  assert.equal(v.pass, true);
  assert.equal(v.issues.length, 0);
});

test("validateResponseAgainstConstraints: fails plan that exceeds 60-hour limit", () => {
  const constraints = extractConstraints("Strict 60-hour limit.");
  const response = `Here is your plan:
Activity 1: Research (25 hours)
Activity 2: Outreach (30 hours)
Activity 3: Networking (25 hours)

Total Hours: 80 hours`;

  const v = validateResponseAgainstConstraints(response, constraints);
  assert.equal(v.pass, false);
  assert.ok(v.issues.some((i) => i.includes("exceeds")));
});

test("validateResponseAgainstConstraints: fails plan offering free trial for unbuilt product", () => {
  const constraints = extractConstraints("I have not built the product yet. How to find first customer?");
  const response = `Step 1: Offer a free trial of your platform to 5 salons.
Step 2: Let them use the software for 2 weeks.`;

  const v = validateResponseAgainstConstraints(response, constraints);
  assert.equal(v.pass, false);
  assert.ok(v.issues.some((i) => i.includes("unbuilt product")));
});

test("validateResponseAgainstConstraints: fails when user corrected error but assistant does not acknowledge", () => {
  const constraints = extractConstraints("Your previous plan exceeded my 60-hour limit.");
  const response = `Here is a plan for 40 hours:
Activity 1: Calls (20 hours)
Activity 2: Demo (20 hours)`;

  const v = validateResponseAgainstConstraints(response, constraints);
  assert.equal(v.pass, false);
  assert.ok(v.issues.some((i) => i.includes("acknowledge")));
});

test("buildConstraintEnforcementPrompt: leaves unconstrained prompt untouched", () => {
  const prompt = "What is Product-Led Growth?";
  const c = extractConstraints(prompt);
  const augmented = buildConstraintEnforcementPrompt(prompt, c);
  assert.equal(augmented, prompt);
});

test("buildConstraintEnforcementPrompt: appends rules when constraints present", () => {
  const prompt = "I have 60 hours total and budget ₹10,000. Have not built product.";
  const c = extractConstraints(prompt);
  const augmented = buildConstraintEnforcementPrompt(prompt, c);
  assert.ok(augmented.includes("STRICT TIME LIMIT: You have a strict total limit of 60 hours"));
  assert.ok(augmented.includes("STRICT BUDGET LIMIT"));
  assert.ok(augmented.includes("UNBUILT PRODUCT RULE"));
});

test("buildCorrectivePrompt: creates actionable retry prompt with specific issues", () => {
  const constraints = extractConstraints("60 hours limit, product not built.");
  const corrective = buildCorrectivePrompt(
    "How to get customer in 60 hours?",
    ["The sum of individual activity hours (85 hours) exceeds the limit of 60 hours."],
    constraints,
  );
  assert.ok(corrective.includes("85 hours"));
  assert.ok(corrective.includes("60 hours"));
});
