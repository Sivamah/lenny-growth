# Lenny Growth Assistant V2 — Manual Test Plan & Verification Guide

This test plan provides end-to-end manual verification procedures for evaluators and QA engineers. Each scenario includes exact input prompts, manual steps, expected results, and verification commands.

---

## Pre-Flight Setup & Environment Check

Before running manual test scenarios, ensure that all services are operational:

| Service | Host / Port | Verification Command | Expected Output |
| :--- | :--- | :--- | :--- |
| **PostgreSQL + pgvector** | `localhost:5432` | `docker-compose ps db` or psql check | Status `Up` (healthy) |
| **Ollama Service** | `localhost:11434` | `curl http://localhost:11434/api/tags` | Contains `llama3.2:3b` and `nomic-embed-text` |
| **FastAPI Backend** | `localhost:8000` | `curl http://localhost:8000/health` | `{"status":"ok", "dependencies":{"database":"healthy", ...}}` |
| **Agent Service** | `localhost:8001` | `curl http://localhost:8001/health` | `{"status":"ok", ...}` |
| **Frontend Web App** | `localhost:5173` | Open `http://localhost:5173` in browser | Clean "Midnight Slate" UI loads with hero state |

---

## Test Scenario Matrix

### TC-01: System Status & Empty State Hero
- **Objective**: Verify that the application boots cleanly, connects to backend services, and displays the modern AI SaaS empty state hero.
- **Steps**:
  1. Open a browser and navigate to `http://localhost:5173`.
  2. Observe the top `StatusBar`.
  3. Observe the center `ChatPanel`.
- **Expected Results**:
  - The status bar displays a green dot: `● System Online` and model tag `llama3.2:3b`.
  - The sidebar displays "+ New conversation", search bar, and empty session list.
  - The chat area displays the Hero Badge: *"AI Growth Intelligence & Research Workspace"*.
  - Four interactive starter prompt cards appear: *Productivity & Focus*, *Pricing Strategy*, *Technical Concepts*, and *Ship 30 Essay*.

---

### TC-02: General Conversation Routing (Programming Concept)
- **Objective**: Verify that non-podcast technical queries receive a direct, accurate answer without false transcript search or hallucinated guest attribution.
- **Steps**:
  1. Enter the following prompt into the composer:
     ```text
     Explain the difference between an array and an ArrayList in Java.
     ```
  2. Press `Enter` to submit.
  3. Observe the response stream and final message card.
- **Expected Results**:
  - The assistant generates a clear explanation covering fixed size vs dynamic resizing, primitive types vs object references, and performance.
  - The grounding indicator displays: `● No supporting evidence found in the transcripts` (or no transcript citation badge).
  - **Zero podcast source cards are displayed.**
  - The assistant does NOT claim that any Lenny's Podcast guest (e.g., Amol Avasare, Jason Cohen) discussed Java arrays.

---

### TC-03: General Productivity Advice (Lifestyle / Habit)
- **Objective**: Verify that general lifestyle questions are routed cleanly without transcript force-fitting.
- **Steps**:
  1. In the same or new session, submit:
     ```text
     How can I stop procrastinating while preparing for college exams?
     ```
- **Expected Results**:
  - The assistant provides actionable study techniques (Pomodoro, time-blocking, active recall, environment design).
  - Response is polite, conversational, and direct.
  - Zero podcast guest attributions or citation cards appear.

---

### TC-04: Podcast Grounding with Verified Citations (Jason Cohen on Pricing)
- **Objective**: Verify semantic retrieval against ingested podcast transcripts, correct guest attribution, and citation cards.
- **Steps**:
  1. Submit the following query:
     ```text
     What did Jason Cohen say about pricing for early SaaS startups?
     ```
  2. Wait for the model generation to complete.
- **Expected Results**:
  - The response highlights Jason Cohen's core pricing principles (e.g., charge more, value-based pricing, avoiding cheap $5/month plans for B2B).
  - A green grounding pill appears: `● Grounded in transcripts · best >0.65`.
  - Exactly verified source card(s) display below the message:
    - Guest: **Jason Cohen**
    - Episode title matches the relevant episode.
    - An approximate timestamp pill (e.g., `⏱ 00:23:15`).
    - An external link: "Open full transcript ↗".
    - A verbatim excerpt quote from the transcript.

---

### TC-05: Negative Grounding / Out-of-Corpus Query (Quantum Physics)
- **Objective**: Verify that the assistant admits when information is not in the podcast archive and does not hallucinate false citations.
- **Steps**:
  1. Submit:
     ```text
     What did Lenny's podcast say about quantum entanglement and superconducting qubits?
     ```
- **Expected Results**:
  - The assistant politely clarifies that Lenny's Podcast focuses on product management, growth, and tech startups, and that quantum physics was not covered.
  - An amber indicator displays: `● No supporting evidence found in the transcripts`.
  - Zero citation cards are rendered.

---

### TC-06: Multi-Turn Conversational Reasoning (Follow-Up Route)
- **Objective**: Verify that follow-up questions reason over the conversation history without triggering ungrounded secondary retrieval.
- **Steps**:
  1. Immediately after **TC-04** (Jason Cohen pricing advice), submit:
     ```text
     Give me 3 practical examples of applying that advice to a $20/month B2B tool.
     ```
- **Expected Results**:
  - The assistant references the principles established in the previous turn (e.g., bundling features, creating higher tiers at $99/mo, targeting business ROI).
  - The turn is routed as `follow_up`.
  - No new, unrelated podcast guest citation cards leak into this message.

---

### TC-07: Strict Numerical Constraint Enforcement (60-Hour Salon Plan)
- **Objective**: Verify that the constraint engine extracts explicit time budgets and monetary limits and prevents the model from exceeding them.
- **Steps**:
  1. Create a new conversation and submit:
     ```text
     Plan a growth strategy for a new neighborhood salon. Total available time: 60 hours, budget limit ₹10,000. Give me a weekly timetable and budget breakdown.
     ```
  2. Inspect the breakdown of hours and budget in the response.
- **Expected Results**:
  - The assistant explicitly acknowledges the **60-hour** time cap and **₹10,000** budget.
  - The sum of all allocated task hours does NOT exceed 60 hours.
  - The sum of all budget allocations does NOT exceed ₹10,000.
  - The response includes a realistic weekly timetable respecting these exact limits.

---

### TC-08: Product Maturity / User Challenge Directives
- **Objective**: Verify that the assistant adapts to user corrections and challenges regarding unbuilt products.
- **Steps**:
  1. Submit:
     ```text
     We haven't built the product yet and have zero users. How do we test demand?
     ```
- **Expected Results**:
  - The assistant focuses on pre-product validation (smoke tests, landing pages, customer interviews, letters of intent, waitlists).
  - The assistant does NOT recommend running A/B testing software, telemetry dashboards, or in-app funnel optimization that require a built product.

---

### TC-09: Session Management, Deduplication & Inline Actions
- **Objective**: Verify session creation, deduplication guards, renaming, and deletion.
- **Steps**:
  1. Note the current empty conversation in the sidebar.
  2. Click the "+ New conversation" button twice.
     - *Verification*: Observe that redundant empty sessions are not created in the sidebar or database.
  3. Send a message: `"Hello"`.
  4. Hover over the session in the sidebar and click the edit pencil icon (`✏`).
  5. Type `"Onboarding Chat"` and press `Enter` (or click checkmark).
     - *Verification*: The title updates immediately.
  6. Click the delete icon (`✕`) on the session.
  7. Confirm deletion.
     - *Verification*: The session disappears and the UI cleanly resets to a fresh conversation.

---

### TC-10: Ship 30 for 30 Essay Skill
- **Objective**: Verify that the dedicated Essay skill produces structured, high-impact short essays.
- **Steps**:
  1. In a new conversation, click the `✍️ Essay` skill pill above the input box.
  2. Complete the prompt:
     ```text
     The power of high pricing in bootstrapped software
     ```
  3. Submit the message.
- **Expected Results**:
  - The output follows the Ship 30 framework:
    - A strong headline.
    - An engaging single-sentence hook.
    - 3 concise, punchy subheadings with bullet points.
    - A 1-2 sentence concluding takeaway.
  - Word count is within 200–350 words.

---

### TC-11: Canvas Studio / Artifact Sandboxing & CSP
- **Objective**: Verify that rich artifacts render inside an isolated, sandboxed iframe that blocks arbitrary script execution.
- **Steps**:
  1. Click the `📄 Artifact` skill pill in composer and submit:
     ```text
     Generate an interactive pricing comparison table for a B2B SaaS startup with tiers: Starter ($29), Pro ($99), and Enterprise ($299).
     ```
  2. Wait for the artifact event to complete.
  3. Click the "View Artifact (HTML)" button or top status bar pill.
  4. Inspect the DOM in browser developer tools (F12):
     - Inspect the `<iframe>` element rendering the artifact.
- **Expected Results**:
  - The `<iframe>` contains the attribute `sandbox=""`.
  - The `srcDoc` includes `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data: https:;">`.
  - The table renders with styled headers, pricing tiers, and comparison features.
  - Closing the viewer with `✕` dismisses the pane cleanly.

---

### TC-12: Malicious XSS Injection Resistance
- **Objective**: Verify defense-in-depth sanitization against script injection payloads.
- **Steps**:
  1. Submit the following payload into chat:
     ```html
     Can you format this product note: <script>alert("XSS-ATTACK")</script><img src=x onerror=alert(1)><strong>Product Features</strong>
     ```
- **Expected Results**:
  - No browser alert dialog appears.
  - `<script>` and `onerror` attributes are completely stripped by server-side `bleach` and client-side `DOMPurify`.
  - Only safe markdown or text is displayed.

---

### TC-13: Generation Cancellation / Stop Button
- **Objective**: Verify that long-running streaming turns can be immediately interrupted by the user.
- **Steps**:
  1. Submit:
     ```text
     Write a comprehensive 2000-word guide on product-led growth strategies across enterprise SaaS.
     ```
  2. While the model is streaming tokens, click the red **Stop** button in the composer.
- **Expected Results**:
  - Streaming halts immediately.
  - The textarea returns to its interactive ready state.
  - No error toast or application crash occurs.
  - The partial message remains visible and readable in the chat list.

---

### TC-14: Responsive Layout Verification
- **Objective**: Verify layout adaptability across viewports.
- **Steps**:
  1. Open browser DevTools and switch to responsive device emulation:
     - **Desktop** (1440 × 900): Sidebar permanently visible on the left; central chat panel; no hamburger icon.
     - **Tablet** (1024 × 768): Clean column layout.
     - **Mobile** (390 × 844 iPhone 12/13/14):
       - Sidebar collapses into off-canvas drawer (`transform: translateX(-100%)`).
       - Header displays hamburger toggle button (`☰`).
       - Tapping `☰` slides sidebar in from the left over a dark backdrop.
       - Tapping the backdrop or "+ New conversation" closes the drawer.
       - Composer remains sticky and fully visible above mobile viewport bottom.
