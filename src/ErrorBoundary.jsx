import { Component } from 'react';

/**
 * Keeps a crash local instead of letting it take the window.
 *
 * React unmounts the entire tree when a render throws with nothing to catch
 * it, and an Electron app has no browser chrome to recover with, so that
 * shows up as a blank white window with the note apparently gone. It is not
 * gone: notes are plain files on disk and nothing here writes to them. But
 * there is no way to tell that from a blank window, which is the worst part.
 *
 * The viewer already wraps each block, so one bad block degrades to plain
 * text. This is for everything outside a block: the parser, the outline, the
 * sidebar, the editor. Wrap a region, name it, and a failure there costs that
 * region rather than the app.
 *
 * `resetKey` clears a failure when the thing being rendered changes, so
 * switching to another note recovers on its own instead of staying broken
 * until restart.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  // Clearing during the render pass rather than after it: a second render
  // just to drop a stale failure would flash the panel for a frame.
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error, info) {
    console.error(`[Casrion] ${this.props.label || 'Region'} crashed:`, error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const retry = () => this.setState({ error: null });
    return (
      <div className="crash-panel">
        <h2>{this.props.title || 'This part hit a problem'}</h2>
        <p>{this.props.hint || 'Your note is safe. Casrion never rewrites a note it could not read, and every note is a plain Markdown file on disk.'}</p>
        <p className="crash-detail">{String(this.state.error && this.state.error.message)}</p>
        <div className="crash-actions">
          <button className="crash-btn" onClick={retry}>Try again</button>
          {this.props.onReload && (
            <button className="crash-btn" onClick={this.props.onReload}>Reload the window</button>
          )}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
