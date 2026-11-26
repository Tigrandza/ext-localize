// Mock dashboard app (copied from an earlier prototype; Submit also sends POST /mock-submit so tests can see it).
// Kept out of index.html so the page can use a strict CSP like Google's.
(function () {
  const h = React.createElement;
  const params = new URLSearchParams(location.search);
  const MARKUP = params.get('markup') === 'aria' ? 'aria' : 'brief';
  const SWITCH = params.get('switch') === 'drop' ? 'drop' : 'keep';
  const DELAY = Number(params.get('delay') || 350);

  // Codes the dashboard uses (note: iw, pt-BR), and visible names.
  const LANGS = [
    { code: 'en', name: 'English' },
    { code: 'pt-BR', name: 'Portuguese (Brazil)' },
    { code: 'iw', name: 'Hebrew' },
    { code: 'de', name: 'German' },
    { code: 'ja', name: 'Japanese' },
  ];
  const PERSIST = params.get('persist') === '1'; // keep "server" state across reloads (sessionStorage), for save+reload tests
  let initialSaved = { en: 'Old English description.', 'pt-BR': '', iw: '', de: 'Alte Beschreibung.', ja: '' };
  if (PERSIST) { try { initialSaved = JSON.parse(sessionStorage.getItem('mockSaved')) || initialSaved; } catch (e) { /* first load */ } }

  const state = window.__mockState = {
    markup: MARKUP, switchMode: SWITCH,
    saved: { ...initialSaved }, drafts: { ...initialSaved },
    current: 'en', saveClicks: 0, submitClicked: false, switches: 0,
  };

  function LangPicker({ current, onPick, disabled }) {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef(null);
    React.useEffect(() => {
      if (!open) return;
      const close = (e) => { if (!e.target.closest('.lang-list') && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', close);
      return () => document.removeEventListener('mousedown', close);
    }, [open]);
    const currentName = LANGS.find(l => l.code === current).name;
    const toggle = () => { if (!disabled) setOpen(o => !o); };
    const rect = ref.current ? ref.current.getBoundingClientRect() : { left: 0, bottom: 0 };
    const style = { left: rect.left + window.scrollX + 'px', top: rect.bottom + window.scrollY + 'px' };

    let list = null;
    if (open) {
      const pick = (code) => { setOpen(false); onPick(code); };
      if (MARKUP === 'brief') {
        list = h('ul', { className: 'lang-list', role: 'listbox', 'aria-label': 'Language', style },
          LANGS.map(l => h('li', { key: l.code, role: 'option', 'data-value': l.code, 'aria-selected': l.code === current, onClick: () => pick(l.code) }, l.name)));
      } else {
        list = h('div', { className: 'lang-list', role: 'listbox', id: 'lang-list', 'aria-label': 'Language', style },
          LANGS.map(l => h('div', { key: l.code, role: 'option', 'aria-selected': l.code === current, onClick: () => pick(l.code) }, l.name)));
      }
      list = ReactDOM.createPortal(list, document.body); // like many UI kits: list lives at the end of <body>
    }

    if (MARKUP === 'brief') {
      return h('div', { className: 'field' },
        h('span', { className: 'field-label' }, 'Current editing language'),
        h('div', { ref, className: 'lang-trigger', role: 'button', tabIndex: 0, 'aria-haspopup': 'listbox', 'aria-expanded': open, onClick: toggle }, currentName, h('span', { className: 'icon', 'aria-hidden': 'true' }, 'arrow_drop_down')),
        list);
    }
    return h('div', { className: 'field' },
      h('label', { id: 'lang-label' }, 'Current editing language'),
      h('div', { ref, className: 'lang-trigger', role: 'combobox', tabIndex: 0, 'aria-labelledby': 'lang-label', 'aria-controls': 'lang-list', 'aria-expanded': open, onClick: toggle }, currentName, h('span', { className: 'icon', 'aria-hidden': 'true' }, 'arrow_drop_down')),
      list);
  }

  function App() {
    const [current, setCurrent] = React.useState('en');
    const [loading, setLoading] = React.useState(false);
    const [drafts, setDrafts] = React.useState({ ...initialSaved });
    const [saved, setSaved] = React.useState({ ...initialSaved });
    const [, force] = React.useState(0);

    // Mirror React state to window.__mockState for tests.
    Object.assign(state, { current, drafts, saved });

    const onPick = (code) => {
      if (code === current) return;
      state.switches++;
      setLoading(true);
      const old = current;
      setTimeout(() => {
        if (SWITCH === 'drop') setDrafts(d => ({ ...d, [old]: saved[old] }));
        setCurrent(code);
        setLoading(false);
      }, DELAY);
    };
    const onSave = () => {
      state.saveClicks++;
      const next = SWITCH === 'keep' ? { ...drafts } : { ...saved, [current]: drafts[current] };
      setSaved(next);
      if (PERSIST) {
        try { sessionStorage.setItem('mockSaved', JSON.stringify(next)); } catch (e) { /* storage blocked */ }
        // Like the real page, saving sends a request. Lets tests check the network recorder.
        fetch('/mock-save?rpc=save', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-xsrf': 'TOKEN123' }, body: JSON.stringify({ item: 'mock', descriptions: next }) }).catch(() => {});
      }
    };
    const onSubmit = () => { state.submitClicked = true; fetch('/mock-submit', { method: 'POST' }).catch(() => {}); force(x => x + 1); };

    const value = drafts[current] || '';
    const textareaProps = {
      key: current, value, rows: 10,
      onChange: (e) => { const v = e.target.value; setDrafts(d => ({ ...d, [current]: v })); },
    };
    let textarea;
    if (MARKUP === 'brief') {
      textarea = h('div', { className: 'field' },
        h('span', { className: 'field-label' }, 'Description'),
        h('textarea', { ...textareaProps, maxLength: 16000 }));
    } else {
      textarea = h('div', { className: 'field' },
        h('label', { htmlFor: 'desc' }, 'Detailed description'),
        h('textarea', { ...textareaProps, id: 'desc', 'aria-describedby': 'desc-help' }),
        h('div', { id: 'desc-help', className: 'counter' }, value.length + ' / 16,000'));
    }

    return h('main', null,
      h('div', { className: 'banner' }, 'LOCAL MOCK — not the real Chrome Web Store. markup=' + MARKUP + ', switch=' + SWITCH + ', delay=' + DELAY + 'ms'),
      h('h1', null, 'Store listing'),
      h(LangPicker, { current, onPick, disabled: loading }),
      loading ? h('div', { className: 'loading', 'aria-busy': 'true' }, 'Loading…') : textarea,
      h('div', { className: 'actions' },
        h('button', { onClick: onSave }, 'Save draft'),
        h('button', { className: 'primary', onClick: onSubmit }, 'Submit for review')),
      state.submitClicked ? h('p', { id: 'submitted' }, 'SUBMIT WAS CLICKED (a tool must never do this)') : null,
      h('h2', null, 'What "Save draft" has stored (server state)'),
      h('pre', { id: 'saved-state' }, JSON.stringify(saved, null, 2)),
      h('h2', null, 'Unsaved drafts (client state)'),
      h('pre', { id: 'draft-state' }, JSON.stringify(drafts, null, 2)));
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
