/** Placeholder shown in the message area before the first message is sent. */

interface Props {
  onExample?: (text: string) => void;
}

const STARTERS = [
  {
    title: "Productivity & Focus",
    desc: "Build a realistic routine and stop procrastinating.",
    icon: "⚡",
    prompt: "How can I stop procrastinating while preparing for college exams?",
  },
  {
    title: "Pricing Strategy",
    desc: "What to do when product growth plateaus.",
    icon: "💡",
    prompt: "What did Jason Cohen say about pricing when a product stops growing?",
  },
  {
    title: "Technical Concepts",
    desc: "Clear programming and engineering explanations.",
    icon: "💻",
    prompt: "Explain the difference between an array and an ArrayList in Java.",
  },
  {
    title: "Ship 30 Essay",
    desc: "Structure high-impact essays from growth ideas.",
    icon: "✍️",
    prompt: "Write a Ship 30 for 30 essay on why distribution is the most important moat.",
  },
];

export function EmptyState({ onExample }: Props) {
  return (
    <div className="empty-state" role="region" aria-label="Welcome screen">
      <div className="empty-state__badge">
        <span className="empty-state__badge-dot" aria-hidden="true" />
        AI Growth Intelligence & Research Workspace
      </div>
      <h1 className="empty-state__title">What would you like to explore today?</h1>
      <p className="empty-state__subtitle">
        Ask general productivity and technical questions, or dive into tactical insights from Lenny's podcast archives.
      </p>
      {onExample && (
        <div className="empty-state__starters" role="list" aria-label="Suggested prompt starters">
          {STARTERS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="starter-tile"
              onClick={() => onExample(s.prompt)}
              role="listitem"
            >
              <div className="starter-tile__icon" aria-hidden="true">{s.icon}</div>
              <div className="starter-tile__content">
                <span className="starter-tile__title">{s.title}</span>
                <span className="starter-tile__desc">{s.desc}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
