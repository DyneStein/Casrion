import { X } from 'lucide-react';

function Shortcut({ keys, action }) {
  return (
    <div className="help-shortcut-row">
      <span className="help-shortcut-action">{action}</span>
      <span className="help-shortcut-keys">
        {keys.split('+').map((k, i) => (
          <span key={i}>
            {i > 0 && <span className="help-key-sep">+</span>}
            <kbd className="help-key">{k}</kbd>
          </span>
        ))}
      </span>
    </div>
  );
}

function HelpPanel({ onClose }) {
  return (
    <div className="help-page-backdrop" onClick={onClose}>
      <div className="help-page" onClick={(e) => e.stopPropagation()}>
        <div className="help-page-header">
          <h1>Help and shortcuts</h1>
          <button className="quit-btn" onClick={onClose} title="Close help">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="help-page-body">
          <section>
            <h2>Overview</h2>
            <p>
              This is a background note taker. It stays out of your way while you read,
              watch or study in other windows, and global keyboard shortcuts send whatever
              you copy straight into your notes. Notes are plain Markdown files stored in
              folders you choose, so they are always yours and always portable.
            </p>
          </section>

          <section>
            <h2>Getting started</h2>
            <ol>
              <li>Click <strong>Add Folder</strong> in the sidebar and pick any folder on your computer. This becomes a workspace.</li>
              <li>Click the <strong>+</strong> icon next to the folder name to create your first note.</li>
              <li>Minimize the window. The app keeps running in the system tray, near the clock.</li>
              <li>Copy anything with Ctrl+C, then press a capture shortcut. A small confirmation appears at the bottom of the screen, and the text lands in your active note.</li>
              <li>To delete a note, hover over it in the sidebar and click the trash icon. Deleted notes and folders go to the Recycle Bin, so you can always restore them.</li>
            </ol>
          </section>

          <section>
            <h2>Capture shortcuts</h2>
            <p>Copy text first with Ctrl+C, then press:</p>
            <Shortcut keys="Ctrl+Shift+C" action="Add the copied text to your note" />
            <Shortcut keys="Ctrl+Shift+1" action="Add as a large heading" />
            <Shortcut keys="Ctrl+Shift+2" action="Add as a medium heading" />
            <Shortcut keys="Ctrl+Shift+3" action="Add as a small heading" />
            <Shortcut keys="Ctrl+Shift+K" action="Add as a code block" />
            <Shortcut keys="Ctrl+Shift+B" action="Add as bold text" />
            <Shortcut keys="Ctrl+Shift+I" action="Add as italic text" />
            <Shortcut keys="Alt+R" action="Add as red text" />
            <Shortcut keys="Alt+G" action="Add as green text" />
            <Shortcut keys="Alt+B" action="Add as blue text" />
            <p>
              Captures from websites keep their structure: lists stay lists, tables stay
              tables, and mathematical formulas are preserved exactly. Copying cells from
              a spreadsheet creates a proper table automatically.
            </p>
          </section>

          <section>
            <h2>Images, voice and more</h2>
            <Shortcut keys="Ctrl+Shift+V" action="Insert the image or screenshot on your clipboard" />
            <Shortcut keys="Ctrl+Shift+M" action="Start or stop a voice memo" />
            <Shortcut keys="Ctrl+Shift+N" action="Start a new paragraph" />
            <Shortcut keys="Ctrl+Shift+Z" action="Undo the last capture" />
            <Shortcut keys="Ctrl+Shift+Y" action="Redo what you just undid" />
            <Shortcut keys="Ctrl+Shift+H" action="Show or hide the quick shortcut overlay" />
            <p>
              To capture a screenshot: press Win+Shift+S, snip the area you want, then press
              Ctrl+Shift+V. The image is saved next to your note and appears inside it.
            </p>
          </section>

          <section>
            <h2>Typing without opening the app</h2>
            <Shortcut keys="Ctrl+Shift+Q" action="Open the quick note popup from anywhere" />
            <p>
              Sometimes you need to write something yourself, like a heading, a thought or
              a reminder, without anything to copy. Press Ctrl+Shift+Q in any application
              and a small input appears on top of your work. Type, pick how it should land
              (plain text, heading, list item or quote, using the buttons at the top, or
              Ctrl+1 through Ctrl+6), and press Enter. It goes straight into your active
              note and the popup disappears. To add several things in a row, press
              Ctrl+Enter instead: the text is added and the popup stays open, ready for
              the next piece, so a heading, some text and a quote take three quick
              entries. You can also write it all at once: Shift+Enter starts a new line,
              and lines beginning with markdown such as #, - or &gt; land as a heading,
              a list item or a quote. Escape or clicking elsewhere closes the popup, and
              anything you had typed is kept as a draft for the next time you open it.
            </p>
          </section>

          <section>
            <h2>Choosing where text lands</h2>
            <p>
              In the reading view, click any paragraph to make it the insertion point. An arrow marks the active spot, and new captures are added right after it.
              Click the area at the very bottom of the note to go back to appending at the end.
            </p>
          </section>

          <section>
            <h2>Source tracking</h2>
            <p>
              The paperclip button in the header turns source tracking on and off. While it
              is on, every capture remembers which window it came from, and copies made in
              a browser also record the web address of the page. Content that has a
              recorded source shows a small marker on its edge. Right-click the text
              to see where and when it was captured, with a clickable link when a web
              address was recorded.
            </p>
          </section>

          <section>
            <h2>Editing and exporting</h2>
            <p>
              The pencil button switches to edit mode, where you can rewrite anything with a
              full formatting toolbar. In edit mode, Ctrl+F opens a search bar that highlights
              every match in the note, Enter jumps to the next one, and Tab indents by four
              spaces. Voice memos appear as small labeled chips there; switch back to the
              reading view to play them. The download button exports the current note as a
              single self-contained HTML file, with all images and audio embedded, ready to
              share or print. The moon button switches between light and dark reading themes.
            </p>
          </section>

          <section>
            <h2>Good to know</h2>
            <ul>
              <li>Closing the window does not quit the app. It keeps capturing from the tray. To quit fully, right-click the tray icon (near the clock) and choose Quit.</li>
              <li>Each notes folder carries its own assets. You can move, copy or back up a folder freely; just add it back from its new location.</li>
              <li>Everything works offline. Your notes never leave your computer.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export default HelpPanel;
