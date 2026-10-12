/**
 * Constraint extraction, validation, and enforcement for Lenny Growth Assistant.
 *
 * Ensures the assistant strictly respects explicit numerical limits (time caps,
 * budgets, deadlines), product maturity (unbuilt/unimplemented products vs working tech),
 * and user corrections/challenges.
 */

export interface ExtractedConstraints {
  hasConstraints: boolean;
  maxHours: number | null;
  maxBudget: { amount: number; currency: string; raw: string } | null;
  unbuiltProduct: boolean;
  isCorrection: boolean;
  negativeDirectives: string[];
}

export interface ValidationResult {
  pass: boolean;
  issues: string[];
  statedTotalHours: number | null;
  sumActivityHours: number | null;
}

/**
 * Extract explicit constraints from the user prompt and conversation history.
 */
export function extractConstraints(prompt: string): ExtractedConstraints {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  // 1. Time / Hour limits
  let maxHours: number | null = null;

  // Pattern A: "Total available time: 60 hours", "Total time: 60 hrs"
  const totalTimeMatch = lower.match(
    /\btotal\s+(?:available\s+)?time[:\s]+(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr)\b/,
  );
  if (totalTimeMatch?.[1]) {
    maxHours = parseFloat(totalTimeMatch[1]);
  }

  // Pattern B: "X hours/day for Y days" -> X * Y
  if (maxHours === null) {
    const dailyMatch = lower.match(
      /(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr)\s*(?:per|\/)\s*day\s*(?:for\s*)?(\d+)\s*days\b/,
    );
    if (dailyMatch?.[1] && dailyMatch?.[2]) {
      const perDay = parseFloat(dailyMatch[1]);
      const days = parseInt(dailyMatch[2], 10);
      maxHours = perDay * days;
    }
  }

  // Pattern C: "60-hour limit", "60 hour limit", "strict 60-hour time limit"
  if (maxHours === null) {
    const limitMatch = lower.match(
      /\b(\d+(?:\.\d+)?)\s*[- ]\s*(?:hour|hr|hours|hrs)\s+(?:time\s+)?(?:limit|cap|maximum|budget)\b/,
    );
    if (limitMatch?.[1]) {
      maxHours = parseFloat(limitMatch[1]);
    }
  }

  // Pattern D: "60 hours total", "60 hours in total", "60 hours max"
  if (maxHours === null) {
    const totalMatch = lower.match(
      /\b(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr)\s+(?:total|in\s+total|max|maximum)\b/,
    );
    if (totalMatch?.[1]) {
      maxHours = parseFloat(totalMatch[1]);
    }
  }

  // Pattern E: "within 60 hours", "only 60 hours in total", "stays within 60 hours", "have 60 hours", "allocate exactly 30 hours"
  if (maxHours === null) {
    const withinMatch = lower.match(
      /\b(?:within|only|exceeded my|have only|have|allotted|allocate\s+(?:exactly\s+)?|limit\s+(?:of\s+)?)\s*(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr)\b/,
    );
    if (withinMatch?.[1]) {
      maxHours = parseFloat(withinMatch[1]);
    }
  }

  // 2. Monetary budget limits
  let maxBudget: { amount: number; currency: string; raw: string } | null = null;
  // Match currency symbols (₹, $, €, £) or names (Rs., INR, USD, EUR, etc.)
  const budgetMatch = text.match(
    /(?:budget(?:\s+of)?[:\s]+|within\s+|spending\s+(?:within\s+)?|limit\s+budget\s+to\s+)(₹|Rs\.?|INR|\$|€|£)\s*([\d,]+(?:\.\d+)?)/i,
  ) || text.match(/(₹|Rs\.?|INR|\$|€|£)\s*([\d,]+(?:\.\d+)?)\s*(?:budget|limit)/i)
    || text.match(/(?:^|[^\w])(₹|Rs\.?|INR|\$|€|£)\s*([\d,]+(?:\.\d+)?)/i);

  if (budgetMatch?.[1] && budgetMatch?.[2]) {
    const currency = budgetMatch[1];
    const amountStr = budgetMatch[2].replace(/,/g, "");
    const amount = parseFloat(amountStr);
    if (!isNaN(amount) && amount > 0) {
      maxBudget = { amount, currency, raw: budgetMatch[0] };
    }
  }

  // 3. Unbuilt / Unimplemented product constraints
  const unbuiltProductPatterns = [
    /\b(?:have not|haven't|not yet|hasn't been|without)\s+built(?:\s+the\s+complete|\s+the|\s+a)?\s+(?:product|platform|software|app|system)\b/i,
    /\b(?:product|software|app|platform)\s+is\s+not\s+(?:yet\s+)?built\b/i,
    /\b(?:before|without)\s+building\s+(?:the\s+)?(?:complete\s+)?(?:product|software|app|platform)\b/i,
    /\b(?:not\s+built\s+the\s+product|no\s+product\s+built|unfinished\s+features|unbuilt)\b/i,
    /\bpretending\s+that\s+unfinished\s+features\s+work\b/i,
  ];
  const unbuiltProduct = unbuiltProductPatterns.some((pattern) => pattern.test(lower));

  // 4. Correction / Challenge indicators
  const correctionPatterns = [
    /\b(?:previous|earlier|last)\s+(?:plan|response|answer|schedule)\s+(?:exceeded|was\s+over|went\s+over|ignored|failed|was\s+wrong|violated|contradicted)\b/i,
    /\b(?:exceeded|exceeds)\s+my\s+\d+[- ]hour\b/i,
    /\b(?:you\s+made\s+a\s+mistake|that'?s\s+(?:incorrect|wrong|not\s+true|not\s+right)|that\s+is\s+incorrect|that\s+was\s+incorrect|you\s+were\s+wrong)\b/i,
    /\b(?:contradicted\s+(?:your\s+)?(?:earlier|previous)|contradicts?\s+(?:your\s+)?(?:earlier|previous))\b/i,
    /\byou\s+(?:said|allocated|gave)\s+.*?\s+but\s+I\s+only\s+have\b/i,
  ];
  const isCorrection = correctionPatterns.some((pattern) => pattern.test(lower));

  // 5. Negative directives (exclusions)
  const negativeDirectives: string[] = [];
  const noDesignMatch = lower.match(
    /\bwithout\s+spending\s+(?:money\s+on\s+)?(?:graphic\s+design|ads|advertising|marketing)\b/i,
  );
  if (noDesignMatch) {
    negativeDirectives.push(noDesignMatch[0]);
  }

  const hasConstraints =
    maxHours !== null ||
    maxBudget !== null ||
    unbuiltProduct ||
    isCorrection ||
    negativeDirectives.length > 0;

  return {
    hasConstraints,
    maxHours,
    maxBudget,
    unbuiltProduct,
    isCorrection,
    negativeDirectives,
  };
}

/**
 * Augment the prompt passed to the model with explicit constraint guardrails
 * when constraints are detected.
 */
export function buildConstraintEnforcementPrompt(
  userPrompt: string,
  constraints: ExtractedConstraints,
): string {
  if (!constraints.hasConstraints) {
    return userPrompt;
  }

  const rules: string[] = [];

  if (constraints.isCorrection) {
    rules.push(
      "- MISTAKE ACKNOWLEDGMENT: The user is correcting an error from a previous turn. Acknowledge and own the previous mistake directly and professionally at the very beginning (e.g., 'You're right, my previous plan exceeded the limit...'). Do NOT defend the previous error.",
    );
  }

  if (constraints.maxHours !== null) {
    rules.push(
      `- STRICT TIME LIMIT: You have a strict total limit of ${constraints.maxHours} hours. If you provide an activity breakdown, you MUST list the hours for each activity, and the SUM of all activities MUST BE <= ${constraints.maxHours} hours. Verify your addition before finalizing your response. State the verified total hours at the end.`,
    );
  }

  if (constraints.maxBudget !== null) {
    rules.push(
      `- STRICT BUDGET LIMIT: Total spending must not exceed ${constraints.maxBudget.currency}${constraints.maxBudget.amount.toLocaleString()}. Keep all recommendations strictly within this budget, and specify realistic low-cost or zero-cost methods.`,
    );
  }

  if (constraints.unbuiltProduct) {
    rules.push(
      "- UNBUILT PRODUCT RULE: The product is NOT yet built. Do NOT offer, assume, or recommend live software trials, automated features, or working product demos. Instead, recommend direct customer interviews, problem discovery conversations, paper/Canva mockups, or concierge (manual) service delivery. Do not pretend unfinished features work.",
    );
  }

  if (constraints.negativeDirectives.length > 0) {
    rules.push(
      `- EXCLUSIONS: Respect the following exclusions: ${constraints.negativeDirectives.join("; ")}.`,
    );
  }

  rules.push(
    "- HONEST OUTCOMES: Describe business outcomes as validation goals and hypotheses to test, not guaranteed customer payments.",
  );

  return `${userPrompt}\n\n[STRICT INSTRUCTIONS & CONSTRAINTS TO ENFORCE]\n${rules.join("\n")}`;
}

/**
 * Validate a draft response against extracted constraints.
 */
export function validateResponseAgainstConstraints(
  response: string,
  constraints: ExtractedConstraints,
): ValidationResult {
  const issues: string[] = [];
  let statedTotalHours: number | null = null;
  let sumActivityHours: number | null = null;

  if (!constraints.hasConstraints) {
    return { pass: true, issues: [], statedTotalHours: null, sumActivityHours: null };
  }

  const lower = response.toLowerCase();

  // 1. Check correction acknowledgment
  if (constraints.isCorrection) {
    const acknowledgmentPatterns = [
      /\b(?:apologize|apologies|you'?re right|previous plan|previous answer|my mistake|oversight|correction|revised the plan|my error)\b/i,
    ];
    const hasAcknowledgment = acknowledgmentPatterns.some((pattern) => pattern.test(lower));
    if (!hasAcknowledgment) {
      issues.push(
        "The response does not acknowledge the user's correction or admit the previous over-allocation.",
      );
    }
  }

  // 2. Check unbuilt product / fake trial violations
  if (constraints.unbuiltProduct) {
    // Flag if it offers a free trial or software demo of the platform without qualification
    const fakeTrialPatterns = [
      /\b(?:offer|provide|give)\s+(?:customers\s+)?(?:a\s+)?(?:\d+[- ]day\s+)?(?:free\s+trial|software\s+trial|platform\s+trial)\b/i,
      /\b(?:trial|demo)\s+of\s+your\s+(?:platform|software|app|product)\b/i,
      /\boffer\s+(?:customers\s+)?(?:a\s+)?(?:\d+[- ]day\s+)?free\s+trial\b/i,
      /\boffer\s+(?:a\s+)?free\s+trial\s+or\s+demo\b/i,
      /\bautomated\s+whatsapp\s+(?:messages?|messaging|automation)\b/i,
    ];
    for (const pattern of fakeTrialPatterns) {
      if (pattern.test(lower)) {
        issues.push(
          "The response recommends offering a free trial or software demo of an unbuilt product. Unbuilt products must use manual concierge service, interviews, or mockups.",
        );
        break;
      }
    }
  }

  // 3. Check time / hours
  if (constraints.maxHours !== null) {
    // A. Check stated total
    const statedMatch = lower.match(
      /\btotal\s*(?:time|hours)?[:\s]+.*?(\d+(?:\.\d+)?)\s*(?:hours|hrs)?\b/,
    );
    if (statedMatch?.[1]) {
      statedTotalHours = parseFloat(statedMatch[1]);
      if (statedTotalHours > constraints.maxHours) {
        issues.push(
          `Stated total of ${statedTotalHours} hours exceeds the strict limit of ${constraints.maxHours} hours.`,
        );
      }
    }

    // B. Extract activity hour items
    // Matches:
    // "- Activity: 4 hours", "* Activity: 4 hours", "1. Activity: 4 hours", "Activity 1: 4 hours"
    const activityHourRegex = /(?:activity\s+\d+|^\s*(?:[-*•]|\d+\.))\s+.*?\b(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr)\b/gim;
    const items: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = activityHourRegex.exec(response)) !== null) {
      if (match[1]) {
        const val = parseFloat(match[1]);
        if (!isNaN(val) && val > 0 && val <= constraints.maxHours * 1.5) {
          items.push(val);
        }
      }
    }

    if (items.length >= 2) {
      sumActivityHours = items.reduce((acc, h) => acc + h, 0);
      if (sumActivityHours > constraints.maxHours + 0.1) {
        issues.push(
          `The sum of individual activity hours (${sumActivityHours} hours) exceeds the limit of ${constraints.maxHours} hours.`,
        );
      }
      if (
        statedTotalHours !== null &&
        Math.abs(statedTotalHours - sumActivityHours) > 1.0 &&
        sumActivityHours > constraints.maxHours
      ) {
        issues.push(
          `The activity breakdown sums to ${sumActivityHours} hours, which contradicts the stated total of ${statedTotalHours} hours.`,
        );
      }
    }
  }

  return {
    pass: issues.length === 0,
    issues,
    statedTotalHours,
    sumActivityHours,
  };
}

/**
 * Build a corrective prompt when draft response fails constraint validation.
 */
export function buildCorrectivePrompt(
  userPrompt: string,
  issues: string[],
  constraints: ExtractedConstraints,
): string {
  const issueBullets = issues.map((i) => `- ${i}`).join("\n");
  const limits: string[] = [];

  if (constraints.maxHours !== null) {
    limits.push(`- Total hours must not exceed ${constraints.maxHours} hours.`);
  }
  if (constraints.maxBudget !== null) {
    limits.push(
      `- Total cost must fit within ${constraints.maxBudget.currency}${constraints.maxBudget.amount.toLocaleString()}.`,
    );
  }
  if (constraints.unbuiltProduct) {
    limits.push(
      "- The product is not yet built: use manual concierge testing, discovery interviews, or mockups instead of software trials or automated demos.",
    );
  }
  if (constraints.isCorrection) {
    limits.push("- Directly acknowledge the previous error at the beginning.");
  }

  return `Your previous draft had the following constraint violations:
${issueBullets}

Please rewrite your response to fix every issue above:
${limits.join("\n")}
Ensure the hours allocated to all activities sum up to less than or equal to ${constraints.maxHours ?? "the limit"}. Verify your addition step by step.

User request:
${userPrompt}`;
}
