// Page-side mock. Relies on window.__sharedWrite/__sharedRead/__sharedReadCollection/__sharedAdd
// being exposed by the Node test harness via page.exposeFunction before this script runs,
// and on window.__mockApplyRemoteWrite(path, data) being callable by the harness to push updates in.
function installFirebaseMock() {
  const authState = { user: null, listeners: [] };
  const localDocStore = {}; // mirrors shared store for this page's synchronous reads
  window.__mockDocListeners = {};
  let idCounter = 1;

  window.__mockApplyRemoteWrite = (path, data) => {
    if (data === null) { delete localDocStore[path]; } else { localDocStore[path] = data; }
    notifyDocListeners(path);
    const parts = path.split('/');
    const parentColPath = parts.slice(0, -1).join('/');
    notifyDocListeners(parentColPath);
    const colName = parts[parts.length - 2];
    if (colName) notifyDocListeners('__cg_' + colName);
  };

  function notifyDocListeners(key) {
    window.__mockDebug && console.log('[mock] notifyDocListeners', key, 'listenerCount=', (window.__mockDocListeners[key] || []).length);
    (window.__mockDocListeners[key] || []).forEach(cb => cb());
  }

  function makeDocRef(colPath, id) {
    const key = colPath + '/' + id;
    return {
      id,
      collection(subName) { return makeColRef(key + '/' + subName); },
      async get() {
        const data = await window.__sharedRead(key);
        if (data) localDocStore[key] = data;
        return { exists: !!data, id, data: () => data || {} };
      },
      async set(data, opts) {
        const merged = await window.__sharedWrite(key, data, !!(opts && opts.merge));
        localDocStore[key] = merged;
      },
      async update(data) {
        const merged = await window.__sharedWrite(key, data, true);
        localDocStore[key] = merged;
      },
      async delete() {
        await window.__sharedWrite(key, null, false);
        delete localDocStore[key];
      },
      onSnapshot(cb) {
        const fn = async () => {
          const data = await window.__sharedRead(key);
          if (data) localDocStore[key] = data; else delete localDocStore[key];
          cb({ exists: !!data, id, data: () => data || {} });
        };
        window.__mockDocListeners[key] = window.__mockDocListeners[key] || [];
        window.__mockDocListeners[key].push(fn);
        fn();
        return () => {
          window.__mockDocListeners[key] = (window.__mockDocListeners[key] || []).filter(f => f !== fn);
        };
      }
    };
  }

  function makeColRef(colPath) {
    const state = { whereField: null, whereVal: null };
    const ref = {
      doc(id) { return makeDocRef(colPath, id || 'auto' + (idCounter++)); },
      orderBy() { return ref; },
      limit() { return ref; },
      where(field, op, val) { state.whereField = field; state.whereVal = val; return ref; },
      async add(data) {
        const id = 'auto' + (idCounter++);
        const key = colPath + '/' + id;
        const merged = await window.__sharedWrite(key, data, false);
        localDocStore[key] = merged;
        return { id };
      },
      onSnapshot(cb) {
        const fn = async () => {
          const rows = await window.__sharedReadCollection(colPath);
          const filtered = state.whereField
            ? rows.filter(r => r.data[state.whereField] === state.whereVal)
            : rows;
          cb({ docs: filtered.map(r => ({ id: r.id, ref: makeDocRef(colPath, r.id), data: () => r.data })), empty: filtered.length === 0 });
        };
        window.__mockDocListeners[colPath] = window.__mockDocListeners[colPath] || [];
        window.__mockDocListeners[colPath].push(fn);
        fn();
        return () => {
          window.__mockDocListeners[colPath] = (window.__mockDocListeners[colPath] || []).filter(f => f !== fn);
        };
      }
    };
    return ref;
  }

  window.firebase = {
    apps: [],
    initializeApp(config) { window.firebase.apps.push({ config }); return window.firebase.apps[0]; },
    app() { return window.firebase.apps[0]; },
    firestore() {
      return {
        collection: (name) => makeColRef(name),
        collectionGroup: (name) => makeCollectionGroupRef(name)
      };
    },
    storage() {
      return { ref() { return { child() { return { async put() { return { ref: { async getDownloadURL() { return 'https://example.invalid/mock.png'; } } }; } }; } }; } };
    },
    auth() {
      return {
        onAuthStateChanged(cb) { authState.listeners.push(cb); cb(authState.user); },
        async signInAnonymously() {
          authState.user = { uid: 'anon-' + Math.random().toString(36).slice(2), isAnonymous: true, email: null, displayName: null };
          authState.listeners.forEach(cb => cb(authState.user));
        },
        // PINログインはこれを呼ぶ。このモックには無かったため、アプリ全体が
        // PIN認証で保護されるようになってから、このテストは起動できなくなっていた
        async signInWithEmailAndPassword(email, password) {
          const record = window.__mockUsers && window.__mockUsers[email];
          if (!record || record.password !== password) {
            const err = new Error('メールアドレスまたはパスワードが違います');
            err.code = 'auth/wrong-password';
            throw err;
          }
          authState.user = record.user;
          authState.listeners.forEach(cb => cb(authState.user));
          return { user: authState.user };
        },
        async createUserWithEmailAndPassword(email, password) {
          const uid = 'uid-' + email.replace(/[^a-zA-Z0-9]/g, '-');
          const user = { uid, isAnonymous: false, email, displayName: null, async updateProfile(p) { user.displayName = p.displayName; } };
          // あとから signInWithEmailAndPassword でログインし直せるように控える
          window.__mockUsers = window.__mockUsers || {};
          window.__mockUsers[email] = { password, user };
          authState.user = user;
          authState.listeners.forEach(cb => cb(authState.user));
          return { user };
        },
        get currentUser() { return authState.user; },
        async signOut() { authState.user = null; authState.listeners.forEach(cb => cb(null)); }
      };
    }
  };
  window.firebase.firestore.FieldValue = { serverTimestamp: () => ({ __ts: Date.now(), toDate: () => new Date() }) };

  // very small collection-group shim: scans all known collections named `name`
  // by asking the harness (which knows the full shared key space).
  function makeCollectionGroupRef(name) {
    const state = { whereField: null, whereVal: null };
    const ref = {
      where(field, op, val) { state.whereField = field; state.whereVal = val; return ref; },
      onSnapshot(cb) {
        const fn = async () => {
          const rows = await window.__sharedReadCollectionGroup(name);
          const filtered = state.whereField
            ? rows.filter(r => r.data[state.whereField] === state.whereVal)
            : rows;
          window.__mockDebug && console.log('[mock] collectionGroup', name, 'rows=', rows.length, 'filtered=', filtered.length, 'whereField=', state.whereField, 'whereVal=', state.whereVal);
          cb({
            docs: filtered.map(r => ({
              id: r.id,
              ref: makeDocRefFromPath(r.path),
              data: () => r.data
            })),
            empty: filtered.length === 0
          });
        };
        window.__mockDocListeners['__cg_' + name] = window.__mockDocListeners['__cg_' + name] || [];
        window.__mockDocListeners['__cg_' + name].push(fn);
        fn();
        return () => {
          window.__mockDocListeners['__cg_' + name] = (window.__mockDocListeners['__cg_' + name] || []).filter(f => f !== fn);
        };
      }
    };
    return ref;
  }

  function makeDocRefFromPath(path) {
    const parts = path.split('/');
    const id = parts[parts.length - 1];
    const colPath = parts.slice(0, -1).join('/');
    const docRef = makeDocRef(colPath, id);
    // emulate ref.parent.parent.id for collectionGroup results (dmChannels/{uid}/calls/{callId})
    docRef.parent = { parent: { id: parts[parts.length - 3] } };
    return docRef;
  }
}
installFirebaseMock();
