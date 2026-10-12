/** Error banner shown above the composer when a chat turn fails. */

interface Props {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, onRetry, onDismiss }: Props) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner__text">{message}</span>
      <div className="error-banner__actions">
        {onRetry && (
          <button type="button" className="error-banner__btn" onClick={onRetry}>
            Retry
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className="error-banner__btn"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
