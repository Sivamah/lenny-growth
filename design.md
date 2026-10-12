# Lenny Growth Assistant V2 — Frontend Design & UI/UX Specification

## 1. Overview & Product Experience

**Lenny Growth Assistant V2** is an AI-powered conversational workspace and research environment for founders, product managers, and growth operators. It combines the contextual depth of *Lenny's Podcast* transcripts with general reasoning and interactive artifact authoring.

The user experience is structured around the **Canvas Studio** paradigm:
1. **Conversational Intelligence**: A chat stream supporting markdown formatting, code highlighting with copy-to-clipboard, interactive prompt starters, real-time stop generation, and citation source cards.
2. **Contextual Transparency**: Clear indicators of whether an answer is grounded in podcast transcripts or drawn from general model reasoning, preventing false guest attribution.
3. **Artifact Workspace**: A sandboxed viewing pane for rich markdown documents and HTML deliverables generated during a conversation (e.g., Ship 30 for 30 essays, PRDs, strategy memos).
4. **Resilient Shell**: Off-canvas mobile navigation, session deduplication, inline conversation renaming, and dark/light/system theme toggles.

---

## 2. Design System & Visual Tokens

The design uses custom CSS tokens defined in `frontend/src/styles/global.css`, avoiding generic framework styling.

### 2.1 Color Palettes

#### Dark Theme ("Midnight Slate") — Default
Tailored for prolonged reading, reduced glare, and high information density:
- **Canvas / App Background**: `--bg-app: #090d16`
- **Sidebar Background**: `--bg-sidebar: #0f1422`
- **Elevated Surfaces**: `--bg-elevated: #131a2b`
- **Cards & Bubbles**: `--bg-card: #161f33`
- **Input Background**: `--bg-input: #111726`
- **Border Lines**: `--border: #1e293b` (Subtle: `#182234`, Focus: `#60a5fa`)
- **Primary Accent**: `--accent: #3b82f6` (Hover: `#60a5fa`, Soft: `rgba(59, 130, 246, 0.12)`)
- **Text Scale**: Main `#f8fafc`, Muted `#cbd5e1`, Subtle `#94a3b8`, Inverse `#090d16`
- **Status Accents**: Success `#10b981`, Warning `#f59e0b`, Danger `#ef4444`

#### Light Theme ("Warm Ivory & Slate")
Clean daylight workspace with high contrast:
- **Canvas / App Background**: `--bg-app: #f8fafc`
- **Sidebar Background**: `--bg-sidebar: #f1f5f9`
- **Elevated Surfaces**: `--bg-elevated: #ffffff`
- **Border Lines**: `--border: #e2e8f0` (Subtle: `#edf2f7`)
- **Text Scale**: Main `#0f172a`, Muted `#475569`, Subtle `#64748b`
- **Primary Accent**: `--accent: #2563eb` (Hover: `#1d4ed8`)

### 2.2 Typography Scale
- **Primary Font**: `Inter`, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
- **Monospace Font**: `Fira Code`, `Cascadia Code`, Consolas, Menlo, Monaco, monospace
- **Hierarchy**:
  - App Header / Titles: 1.25rem (20px), Semi-Bold (600)
  - Section Headings: 1.125rem (18px), Medium (500)
  - Body Copy: 0.9375rem (15px), Regular (400), Line-Height 1.6
  - Metadata / Badges / Timestamps: 0.8125rem (13px), Medium (500), Tabular Numerals
  - Micro-labels: 0.75rem (12px), Medium (500)

### 2.3 Radii, Elevations & Motion
- **Radii**: Small `6px`, Medium `10px`, Large `14px`, Full `9999px`
- **Elevations**:
  - Card: `0 4px 6px -1px rgba(15, 23, 42, 0.08)`
  - Elevated Popover / Modal: `0 10px 15px -3px rgba(15, 23, 42, 0.08)`
  - Off-Canvas Drawer: `8px 0 24px rgba(15, 23, 42, 0.25)`
- **Transitions**: Smooth micro-interactions (`150ms` fast, `220ms` normal cubic-bezier).

---

## 3. Component Hierarchy & Architecture

```
[ App (Shell) ]
  ├── [ SessionSidebar ]
  │     ├── Header (+ New conversation button, mobile close toggle)
  │     ├── SearchFilterInput (real-time text filter + clear button)
  │     ├── SessionList (grouped: Today, Previous 7 Days, Older)
  │     │     └── SessionItem (active highlight, inline rename, delete confirmation)
  │     └── ThemeSelector (Light / Dark / System pills)
  │
  └── [ AppMain ]
        ├── [ StatusBar ]
        │     ├── MobileMenuToggle (☰ button, ≤768px viewports)
        │     ├── ActiveConversationTitle (truncated with ellipsis)
        │     ├── QuickArtifactButton ("📄 View Artifact" pill)
        │     ├── QuickNewChatButton ("+ New chat")
        │     └── SystemHealthPill (Status dot, latency, active model badge)
        │
        ├── [ ChatPanel ]
        │     ├── [ ErrorBanner ] (dismissible warning with retry action)
        │     ├── [ MessageList ]
        │     │     ├── [ EmptyState ] (Hero badge, title, 4 starter prompt cards)
        │     │     └── [ MessageBubble ] (User / Assistant)
        │     │           ├── MarkdownRenderer (lists, blockquotes, tables)
        │     │           ├── CodeBlock (language pill + "📋 Copy" / "✓ Copied" button)
        │     │           ├── GroundingPill (transcript match status + score)
        │     │           ├── [ Citations ] (verified source cards with timestamps)
        │     │           └── ModelBadge (e.g., llama3.2:3b / local)
        │     └── [ Composer ]
        │           ├── SkillPills (✍️ Essay, 📄 Artifact)
        │           ├── AutoExpandingTextarea (Enter to send, Shift+Enter for newline)
        │           └── ActionButtons (Send icon / Stop generation square)
        │
        └── [ ArtifactViewer ] (Overlay / Side-by-side pane)
              ├── ArtifactHeader (Title, KIND badge, close button)
              └── SandboxedIframe (sandbox="", inline CSP, DOMPurify sanitized HTML)
```

---

## 4. Key UI/UX Decisions & Interaction Patterns

### 4.1 Empty-Session Guard & Session Deduplication
- **Problem**: Users clicking "+ New conversation" repeatedly could spawn empty sessions in the database, cluttering the sidebar.
- **Solution**:
  - `createSession()` checks if `messages.length === 0`. If the active session is already empty, the application keeps focus on it without issuing redundant backend requests.
  - All sidebar updates run through `dedupeSessions(list)` to prevent duplicate keys or repeated entries.

### 4.2 Conversational Routing & Transparent Grounding
- **Problem**: Earlier prototypes forced every prompt through transcript retrieval, causing general questions (e.g., Java code or study advice) to invent guest attributions.
- **Solution**:
  - The UI explicitly renders grounding indicators:
    - **Grounded**: Emerald pill `● Grounded in transcripts · best 0.71` with verified citation cards.
    - **General / Ungrounded**: Amber pill `● No supporting evidence found in the transcripts`.
    - **Suppressed Sources**: Citations are completely omitted on ungrounded turns or follow-up conversational answers to avoid misleading the user.

### 4.3 Verified Source Cards (`<Citations />`)
When podcast evidence is retrieved and verified:
- **Card Structure**:
  - Header: Guest name (e.g., *Jason Cohen*), episode title, and relevance confidence score (e.g., `Score: 0.74`).
  - Metadata: Timestamp badge (e.g., `⏱ 00:23:15`), linking directly to the transcript anchor when available.
  - Body: Verbatim excerpt from the transcript in an italicized blockquote.
  - External Link: "Open full transcript ↗" pointing to the original episode publication.

### 4.4 Composer & Skill Starters
- **Sticky Layout**: Remains anchored at the bottom with a subtle background blur gradient.
- **Skill Buttons**:
  - `✍️ Essay`: Prefixes the prompt with Ship 30 for 30 essay formatting directives.
  - `📄 Artifact`: Engages artifact generation mode, signaling the backend to produce structured, exportable markdown or HTML.
- **Input Controls**:
  - `Enter`: Submits message (when not empty and not currently streaming).
  - `Shift + Enter`: Inserts a newline.
  - `Stop`: Appears while streaming SSE tokens, immediately terminating the connection via `AbortController`.

### 4.5 Sandboxed Canvas Studio (`<ArtifactViewer />`)
- **Security & Rendering Pipeline**:
  1. The assistant produces structured markdown or HTML.
  2. Server sanitizes raw HTML via Python `bleach`.
  3. Client performs a second sanitization pass with `DOMPurify` (stripping `<script>`, `<iframe>`, `<object>`, form tags, and event handlers like `onload` / `onerror`).
  4. Content is injected into an isolated `<iframe>` configured with:
     - `sandbox=""` (disallowing script execution, form submission, and same-origin access).
     - Inline Content Security Policy: `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data: https:;`.

### 4.6 Responsive Layout & Mobile Off-Canvas Drawer
- **Desktop (≥1024px)**: Fixed 280px left sidebar, fluid central chat column (max-width 840px), and right-anchored artifact workspace.
- **Tablet (768px – 1024px)**: Collapsible sidebar with quick toggle, full-width chat container.
- **Mobile (≤768px)**:
  - Sidebar transforms into an **off-canvas drawer** (`transform: translateX(-100%)` to `translateX(0)`).
  - Darkened backdrop overlay (`.sidebar-backdrop`) dismisses drawer on tap.
  - Header displays a dedicated hamburger menu button (`☰`) and compact session label.
  - Touch-friendly touch targets (min 44px) and comfortable virtual keyboard clearance.

---

## 5. Accessibility (a11y) & Performance

1. **Contrast Compliance**: Both Dark ("Midnight Slate") and Light themes satisfy WCAG 2.1 AA standards (minimum 4.5:1 for body copy and 3:1 for large text and interactive boundaries).
2. **Focus Indicators**: Explicit 2px focus rings (`--border-focus`) on inputs, buttons, and session links for keyboard navigation.
3. **Screen Readers**: Aria labels on icon-only buttons (`aria-label="Close artifact"`, `aria-label="New conversation"`, `aria-label="Toggle navigation"`).
4. **Non-Intrusive Auto-Scroll**: Message streaming scrolls smoothly to the latest token only if the user is already near the bottom; it preserves manual scroll position when reading past turns.
5. **Vite Bundle Efficiency**: Code splitting and modular imports yield an optimized production client bundle compiling in under 300ms.
