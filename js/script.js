(function () {
  'use strict';

  /* ============================================================
   * 가상 파일시스템 헬퍼
   * ========================================================== */
  const HOME_PATH = ['home', 'user'];

  function D(children, perm) {
    return { type: 'dir', perm: perm || 'rwxr-xr-x', children: children || {} };
  }
  function F(content, perm) {
    return { type: 'file', content: content || '', perm: perm || 'rw-r--r--' };
  }
  function buildRoot(homeChildren) {
    return D({ home: D({ user: D(homeChildren) }) });
  }
  function cloneTree(node) {
    return JSON.parse(JSON.stringify(node));
  }
  function arraysEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function getNode(root, segs) {
    let node = root;
    for (const s of segs) {
      if (!node || node.type !== 'dir' || !node.children[s]) return null;
      node = node.children[s];
    }
    return node;
  }

  function resolvePath(cwd, inputPath) {
    if (!inputPath || inputPath === '.') return cwd.slice();
    let segs;
    let rest = inputPath;
    if (rest.startsWith('~')) {
      segs = HOME_PATH.slice();
      rest = rest.slice(1);
      if (rest.startsWith('/')) rest = rest.slice(1);
    } else if (rest.startsWith('/')) {
      segs = [];
      rest = rest.slice(1);
    } else {
      segs = cwd.slice();
    }
    if (rest === '') return segs;
    const parts = rest.split('/').filter((p) => p !== '');
    for (const part of parts) {
      if (part === '.') continue;
      else if (part === '..') { if (segs.length > 0) segs.pop(); }
      else segs.push(part);
    }
    return segs;
  }

  function getNodeFromHome(ctx, relPath) {
    const segs = HOME_PATH.concat(relPath.split('/').filter(Boolean));
    return getNode(ctx.root, segs);
  }

  function tokenize(s) {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    const tokens = [];
    let m;
    while ((m = re.exec(s))) {
      tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    }
    return tokens;
  }

  function wildcardToRegex(p) {
    const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + esc + '$');
  }

  function displayPath(cwd) {
    if (cwd.length >= HOME_PATH.length && arraysEqual(cwd.slice(0, HOME_PATH.length), HOME_PATH)) {
      const rest = cwd.slice(HOME_PATH.length);
      return '~' + (rest.length ? '/' + rest.join('/') : '');
    }
    return '/' + cwd.join('/');
  }

  const PERM_TABLE = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];

  function applySymbolicChmod(perm, modeStr) {
    const clauses = modeStr.split(',');
    let chars = perm.split('');
    for (const clause of clauses) {
      const m = clause.match(/^([ugoa]*)([+-])([rwx]+)$/);
      if (!m) return null;
      let who = m[1] || 'a';
      const sign = m[2];
      const bits = m[3];
      const targets = [];
      if (who.includes('u') || who.includes('a')) targets.push(0);
      if (who.includes('g') || who.includes('a')) targets.push(3);
      if (who.includes('o') || who.includes('a')) targets.push(6);
      for (const base of targets) {
        for (const b of bits) {
          const idx = base + (b === 'r' ? 0 : b === 'w' ? 1 : 2);
          chars[idx] = sign === '+' ? b : '-';
        }
      }
    }
    return chars.join('');
  }

  /* ============================================================
   * 명령어 구현
   * ========================================================== */
  function pwdCmd(args, ctx) {
    return { output: ['/' + ctx.cwd.join('/')] };
  }

  function lsCmd(args, ctx) {
    const flagStr = args.filter((a) => a.startsWith('-')).join('');
    const showAll = flagStr.includes('a');
    const longFmt = flagStr.includes('l');
    const targets = args.filter((a) => !a.startsWith('-'));
    const targetPath = targets[0] || '.';
    const segs = resolvePath(ctx.cwd, targetPath);
    const node = getNode(ctx.root, segs);
    if (!node) return { error: `ls: cannot access '${targetPath}': No such file or directory` };
    if (node.type === 'file') return { output: [targetPath] };
    let names = Object.keys(node.children);
    if (!showAll) names = names.filter((n) => !n.startsWith('.'));
    names.sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return { output: [] };
    if (longFmt) {
      return {
        output: names.map((n) => {
          const c = node.children[n];
          const typeChar = c.type === 'dir' ? 'd' : '-';
          return `${typeChar}${c.perm}  ${n}`;
        }),
      };
    }
    return { output: names };
  }

  function cdCmd(args, ctx) {
    const target = args[0] || '~';
    const segs = resolvePath(ctx.cwd, target);
    const node = getNode(ctx.root, segs);
    if (!node) return { error: `cd: no such file or directory: ${target}` };
    if (node.type !== 'dir') return { error: `cd: not a directory: ${target}` };
    ctx.cwd = segs;
    return { output: [] };
  }

  function catCmd(args, ctx, stdin) {
    if (args.length === 0) {
      if (stdin) return { output: stdin };
      return { error: 'cat: missing operand' };
    }
    let lines = [];
    for (const a of args) {
      const segs = resolvePath(ctx.cwd, a);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `cat: ${a}: No such file or directory` };
      if (node.type === 'dir') return { error: `cat: ${a}: Is a directory` };
      lines = lines.concat(node.content.split('\n'));
    }
    return { output: lines };
  }

  function echoCmd(args) {
    return { output: [args.join(' ')] };
  }

  function mkdirCmd(args, ctx) {
    if (args.length === 0) return { error: 'mkdir: missing operand' };
    const flagP = args.includes('-p');
    const targets = args.filter((a) => a !== '-p');
    for (const t of targets) {
      const segs = resolvePath(ctx.cwd, t);
      const name = segs.pop();
      if (!name) return { error: `mkdir: cannot create directory '${t}'` };
      let parent;
      if (flagP) {
        parent = ctx.root;
        for (const s of segs) {
          if (!parent.children[s]) parent.children[s] = D({});
          if (parent.children[s].type !== 'dir') return { error: `mkdir: cannot create directory '${t}': Not a directory` };
          parent = parent.children[s];
        }
      } else {
        parent = getNode(ctx.root, segs);
        if (!parent || parent.type !== 'dir') return { error: `mkdir: cannot create directory '${t}': No such file or directory` };
      }
      if (parent.children[name]) return { error: `mkdir: cannot create directory '${t}': File exists` };
      parent.children[name] = D({});
    }
    return { output: [] };
  }

  function touchCmd(args, ctx) {
    if (args.length === 0) return { error: 'touch: missing operand' };
    for (const t of args) {
      const segs = resolvePath(ctx.cwd, t);
      const name = segs.pop();
      if (!name) return { error: `touch: cannot touch '${t}'` };
      const parent = getNode(ctx.root, segs);
      if (!parent || parent.type !== 'dir') return { error: `touch: cannot touch '${t}': No such file or directory` };
      if (!parent.children[name]) parent.children[name] = F('');
    }
    return { output: [] };
  }

  function rmCmd(args, ctx) {
    const recursive = args.includes('-r') || args.includes('-R') || args.includes('-rf') || args.includes('-fr');
    const force = args.includes('-f') || args.includes('-rf') || args.includes('-fr');
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.length === 0) return { error: 'rm: missing operand' };
    for (const t of targets) {
      const segs = resolvePath(ctx.cwd, t);
      const name = segs.pop();
      const parent = getNode(ctx.root, segs);
      if (!parent || !parent.children[name]) {
        if (force) continue;
        return { error: `rm: cannot remove '${t}': No such file or directory` };
      }
      const node = parent.children[name];
      if (node.type === 'dir' && !recursive) return { error: `rm: cannot remove '${t}': Is a directory` };
      delete parent.children[name];
    }
    return { output: [] };
  }

  function cpCmd(args, ctx) {
    const recursive = args.includes('-r') || args.includes('-R');
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.length < 2) return { error: 'cp: missing file operand' };
    const src = targets[0];
    const destArg = targets[1];
    const srcSegs = resolvePath(ctx.cwd, src);
    const srcNode = getNode(ctx.root, srcSegs);
    if (!srcNode) return { error: `cp: cannot stat '${src}': No such file or directory` };
    if (srcNode.type === 'dir' && !recursive) return { error: `cp: -r not specified; omitting directory '${src}'` };
    const destSegs = resolvePath(ctx.cwd, destArg);
    const destNode = getNode(ctx.root, destSegs);
    let finalParentSegs, finalName;
    if (destNode && destNode.type === 'dir') {
      finalParentSegs = destSegs;
      finalName = srcSegs[srcSegs.length - 1];
    } else {
      finalParentSegs = destSegs.slice(0, -1);
      finalName = destSegs[destSegs.length - 1];
    }
    const parent = getNode(ctx.root, finalParentSegs);
    if (!parent || parent.type !== 'dir') return { error: `cp: cannot create '${destArg}': No such file or directory` };
    parent.children[finalName] = cloneTree(srcNode);
    return { output: [] };
  }

  function mvCmd(args, ctx) {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.length < 2) return { error: 'mv: missing file operand' };
    const src = targets[0];
    const destArg = targets[1];
    const srcSegs = resolvePath(ctx.cwd, src);
    const srcName = srcSegs[srcSegs.length - 1];
    const srcParent = getNode(ctx.root, srcSegs.slice(0, -1));
    if (!srcParent || !srcParent.children[srcName]) return { error: `mv: cannot stat '${src}': No such file or directory` };
    const srcNode = srcParent.children[srcName];
    const destSegs = resolvePath(ctx.cwd, destArg);
    const destNode = getNode(ctx.root, destSegs);
    let finalParentSegs, finalName;
    if (destNode && destNode.type === 'dir') {
      finalParentSegs = destSegs;
      finalName = srcName;
    } else {
      finalParentSegs = destSegs.slice(0, -1);
      finalName = destSegs[destSegs.length - 1];
    }
    const parent = getNode(ctx.root, finalParentSegs);
    if (!parent || parent.type !== 'dir') return { error: `mv: cannot move to '${destArg}': No such file or directory` };
    delete srcParent.children[srcName];
    parent.children[finalName] = srcNode;
    return { output: [] };
  }

  function grepCmd(args, ctx, stdin) {
    const flags = args.filter((a) => a.startsWith('-'));
    const rest = args.filter((a) => !a.startsWith('-'));
    const caseInsensitive = flags.includes('-i');
    const recursive = flags.includes('-r') || flags.includes('-R');
    const pattern = rest[0];
    if (!pattern) return { error: 'grep: missing pattern' };
    const test = caseInsensitive
      ? (l) => l.toLowerCase().includes(pattern.toLowerCase())
      : (l) => l.includes(pattern);

    if (recursive) {
      const startArg = rest[1] || '.';
      const startSegs = resolvePath(ctx.cwd, startArg);
      const startNode = getNode(ctx.root, startSegs);
      if (!startNode) return { error: `grep: ${startArg}: No such file or directory` };
      const output = [];
      (function walk(node, displaySegs) {
        if (node.type === 'dir') {
          for (const name of Object.keys(node.children)) walk(node.children[name], displaySegs.concat([name]));
        } else {
          node.content.split('\n').forEach((line) => {
            if (test(line)) output.push(`${displaySegs.join('/')}: ${line}`);
          });
        }
      })(startNode, [startArg.replace(/\/$/, '')]);
      return { output };
    }

    let lines;
    if (rest.length > 1) {
      const fname = rest[1];
      const segs = resolvePath(ctx.cwd, fname);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `grep: ${fname}: No such file or directory` };
      if (node.type === 'dir') return { error: `grep: ${fname}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'grep: 파일이나 파이프 입력이 필요합니다' };
    }
    return { output: lines.filter(test) };
  }

  function findCmd(args, ctx) {
    let startArg = '.';
    let namePattern = null;
    let typeFilter = null;
    let i = 0;
    if (args[i] && !args[i].startsWith('-')) { startArg = args[i]; i++; }
    while (i < args.length) {
      if (args[i] === '-name') { namePattern = args[i + 1]; i += 2; }
      else if (args[i] === '-type') { typeFilter = args[i + 1]; i += 2; }
      else i++;
    }
    if (!namePattern && !typeFilter) return { error: 'find: -name 또는 -type 옵션이 필요합니다 (예: find . -name "file.txt", find . -type d)' };
    const startSegs = resolvePath(ctx.cwd, startArg);
    const startNode = getNode(ctx.root, startSegs);
    if (!startNode) return { error: `find: '${startArg}': No such file or directory` };
    const regex = namePattern ? wildcardToRegex(namePattern) : null;
    const results = [];
    (function walk(node, displaySegs) {
      if (node.type !== 'dir') return;
      for (const name of Object.keys(node.children)) {
        const child = node.children[name];
        const newDisplay = displaySegs.concat([name]);
        const nameMatches = regex ? regex.test(name) : true;
        const typeMatches = typeFilter ? (typeFilter === 'd' ? child.type === 'dir' : child.type === 'file') : true;
        if (nameMatches && typeMatches) results.push(newDisplay.join('/'));
        walk(child, newDisplay);
      }
    })(startNode, [startArg.replace(/\/$/, '')]);
    return { output: results };
  }

  function chmodCmd(args, ctx) {
    if (args.length < 2) return { error: 'chmod: missing operand' };
    const mode = args[0];
    const target = args[1];
    const segs = resolvePath(ctx.cwd, target);
    const node = getNode(ctx.root, segs);
    if (!node) return { error: `chmod: cannot access '${target}': No such file or directory` };
    let newPerm;
    if (/^[0-7]{3,4}$/.test(mode)) {
      const digits = mode.length === 4 ? mode.slice(1) : mode;
      newPerm = digits.split('').map((d) => PERM_TABLE[+d]).join('');
    } else {
      newPerm = applySymbolicChmod(node.perm, mode);
      if (!newPerm) return { error: `chmod: invalid mode: '${mode}'` };
    }
    node.perm = newPerm;
    return { output: [] };
  }

  function wcCmd(args, ctx, stdin) {
    const flags = args.filter((a) => a.startsWith('-'));
    const rest = args.filter((a) => !a.startsWith('-'));
    let content, name = null;
    if (rest.length > 0) {
      name = rest[0];
      const segs = resolvePath(ctx.cwd, name);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `wc: ${name}: No such file or directory` };
      if (node.type === 'dir') return { error: `wc: ${name}: Is a directory` };
      content = node.content;
    } else if (stdin) {
      content = stdin.join('\n');
    } else {
      return { error: 'wc: 파일이나 파이프 입력이 필요합니다' };
    }
    const lineCount = content === '' ? 0 : content.split('\n').length;
    const wordCount = content.trim() === '' ? 0 : content.trim().split(/\s+/).length;
    const charCount = content.length;
    let parts = [];
    if (flags.includes('-l')) parts.push(String(lineCount));
    else if (flags.includes('-w')) parts.push(String(wordCount));
    else if (flags.includes('-c')) parts.push(String(charCount));
    else parts.push(String(lineCount), String(wordCount), String(charCount));
    if (name) parts.push(name);
    return { output: [parts.join(' ')] };
  }

  function parseCountFlag(args, defaultN) {
    let n = defaultN;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { n = parseInt(args[i + 1], 10) || defaultN; i++; }
      else if (/^-n\d+$/.test(args[i])) { n = parseInt(args[i].slice(2), 10); }
      else rest.push(args[i]);
    }
    return { n, rest };
  }

  function headCmd(args, ctx, stdin) {
    const { n, rest } = parseCountFlag(args, 10);
    let lines;
    if (rest.length > 0) {
      const segs = resolvePath(ctx.cwd, rest[0]);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `head: ${rest[0]}: No such file or directory` };
      if (node.type === 'dir') return { error: `head: ${rest[0]}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'head: 파일이나 파이프 입력이 필요합니다' };
    }
    return { output: lines.slice(0, n) };
  }

  function tailCmd(args, ctx, stdin) {
    const { n, rest } = parseCountFlag(args, 10);
    let lines;
    if (rest.length > 0) {
      const segs = resolvePath(ctx.cwd, rest[0]);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `tail: ${rest[0]}: No such file or directory` };
      if (node.type === 'dir') return { error: `tail: ${rest[0]}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'tail: 파일이나 파이프 입력이 필요합니다' };
    }
    return { output: lines.slice(-n) };
  }

  function sortCmd(args, ctx, stdin) {
    const reverse = args.includes('-r');
    const numeric = args.includes('-n');
    const rest = args.filter((a) => !a.startsWith('-'));
    let lines;
    if (rest.length > 0) {
      const segs = resolvePath(ctx.cwd, rest[0]);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `sort: ${rest[0]}: No such file or directory` };
      if (node.type === 'dir') return { error: `sort: ${rest[0]}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'sort: 파일이나 파이프 입력이 필요합니다' };
    }
    const sorted = lines.slice().sort((a, b) => (numeric ? parseFloat(a) - parseFloat(b) : a.localeCompare(b)));
    if (reverse) sorted.reverse();
    return { output: sorted };
  }

  function uniqCmd(args, ctx, stdin) {
    const showCount = args.includes('-c');
    const rest = args.filter((a) => !a.startsWith('-'));
    let lines;
    if (rest.length > 0) {
      const segs = resolvePath(ctx.cwd, rest[0]);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `uniq: ${rest[0]}: No such file or directory` };
      if (node.type === 'dir') return { error: `uniq: ${rest[0]}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'uniq: 파일이나 파이프 입력이 필요합니다' };
    }
    const output = [];
    const rawLast = [];
    for (const line of lines) {
      if (rawLast.length > 0 && rawLast[rawLast.length - 1] === line) {
        if (showCount) {
          const idx = output.length - 1;
          const m = output[idx].match(/^(\d+) (.*)$/);
          output[idx] = `${parseInt(m[1], 10) + 1} ${m[2]}`;
        }
        continue;
      }
      output.push(showCount ? `1 ${line}` : line);
      rawLast.push(line);
    }
    return { output };
  }

  /* ---------- 프로세스 / 네트워크 (가상 프로세스 목록 기반) ---------- */
  function psCmd(args, ctx) {
    const procs = ctx.processes || [];
    if (args.includes('aux')) {
      const header = 'USER       PID  %CPU %MEM COMMAND';
      const lines = procs.map((p) => `user    ${String(p.pid).padEnd(7)}${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${p.name}`);
      return { output: [header, ...lines] };
    }
    const header = '  PID CMD';
    const lines = procs.map((p) => `${String(p.pid).padStart(5)} ${p.name}`);
    return { output: [header, ...lines] };
  }

  function killCmd(args, ctx) {
    const force = args.includes('-9') || args.includes('-KILL') || args.includes('-SIGKILL');
    const pidArgs = args.filter((a) => !a.startsWith('-'));
    if (pidArgs.length === 0) return { error: 'kill: usage: kill [-9] pid' };
    const procs = ctx.processes || [];
    for (const pidStr of pidArgs) {
      const pid = parseInt(pidStr, 10);
      const idx = procs.findIndex((p) => p.pid === pid);
      if (idx === -1) return { error: `kill: (${pid}): No such process` };
      const proc = procs[idx];
      if (proc.stubborn && !force) continue;
      procs.splice(idx, 1);
    }
    return { output: [] };
  }

  function netstatCmd(args, ctx) {
    const procs = (ctx.processes || []).filter((p) => p.port);
    if (procs.length === 0) return { output: ['(열려있는 포트가 없습니다)'] };
    const header = 'Proto  Local Address        PID/Program name';
    const lines = procs.map((p) => `tcp    0.0.0.0:${p.port}         ${p.pid}/${p.name}`);
    return { output: [header, ...lines] };
  }

  function lsofCmd(args, ctx) {
    const joined = args.join(' ');
    const m = joined.match(/:(\d+)/);
    if (!m) return { error: 'lsof: usage: lsof -i :PORT' };
    const port = parseInt(m[1], 10);
    const proc = (ctx.processes || []).find((p) => p.port === port);
    if (!proc) return { output: [] };
    const header = 'COMMAND     PID USER   TYPE   NAME';
    const line = `${proc.name.padEnd(10)} ${String(proc.pid).padEnd(6)} user  IPv4   *:${proc.port} (LISTEN)`;
    return { output: [header, line] };
  }

  function curlCmd(args, ctx) {
    const flags = args.filter((a) => a.startsWith('-'));
    const headOnly = flags.includes('-I') || flags.includes('-i');
    const urlArg = args.find((a) => !a.startsWith('-'));
    if (!urlArg) return { error: "curl: try 'curl --help' for more information" };
    const m = urlArg.match(/^https?:\/\/[^:/]+(?::(\d+))?/);
    const port = m && m[1] ? parseInt(m[1], 10) : 80;
    const proc = (ctx.processes || []).find((p) => p.port === port);
    if (!proc) return { error: `curl: (7) Failed to connect to port ${port}: Connection refused` };
    const status = proc.httpStatus || 200;
    if (headOnly) return { output: [`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`, 'Content-Type: application/json'] };
    return { output: [proc.response || '{"status":"ok"}'] };
  }

  function sleepCmd() { return { output: [] }; }

  function nohupCmd(args, ctx, stdin) {
    const inner = args[0];
    if (!inner) return { error: 'nohup: missing operand' };
    const fn = COMMANDS[inner];
    if (!fn) return { error: `nohup: failed to run command '${inner}': No such file or directory` };
    return fn(args.slice(1), ctx, stdin) || {};
  }

  function jobsCmd(args, ctx) {
    const jobs = ctx.jobs || [];
    if (jobs.length === 0) return { output: ['표시할 백그라운드 작업이 없습니다.'] };
    return { output: jobs.map((j) => `[${j.id}]+  Running                 ${j.cmd} &`) };
  }

  /* ---------- 텍스트 처리 심화 ---------- */
  function sedCmd(args, ctx, stdin) {
    const script = args.find((a) => a.startsWith('s/'));
    if (!script) return { error: "sed: -e expression #1, char 0: no previous regular expression" };
    const m = script.match(/^s\/(.*)\/(.*)\/(g)?$/);
    if (!m) return { error: `sed: invalid script: ${script}` };
    const pattern = m[1];
    const replacement = m[2];
    const gflag = m[3];
    const rest = args.filter((a) => a !== script);
    let lines;
    if (rest.length > 0) {
      const segs = resolvePath(ctx.cwd, rest[0]);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `sed: can't read ${rest[0]}: No such file or directory` };
      if (node.type === 'dir') return { error: `sed: ${rest[0]}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'sed: 파일이나 파이프 입력이 필요합니다' };
    }
    const output = lines.map((line) => (gflag ? line.split(pattern).join(replacement) : line.replace(pattern, replacement)));
    return { output };
  }

  function awkCmd(args, ctx, stdin) {
    let delim = null;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-F') { delim = args[i + 1]; i++; }
      else if (args[i].startsWith('-F') && args[i].length > 2) { delim = args[i].slice(2); }
      else rest.push(args[i]);
    }
    const script = rest.find((a) => a.includes('print'));
    if (!script) return { error: 'awk: syntax error' };
    const fm = script.match(/\$(\d+)/);
    const fieldNum = fm ? parseInt(fm[1], 10) : 0;
    const fileArgs = rest.filter((a) => a !== script);
    let lines;
    if (fileArgs.length > 0) {
      const segs = resolvePath(ctx.cwd, fileArgs[0]);
      const node = getNode(ctx.root, segs);
      if (!node) return { error: `awk: can't open file ${fileArgs[0]}` };
      if (node.type === 'dir') return { error: `awk: ${fileArgs[0]}: Is a directory` };
      lines = node.content.split('\n');
    } else if (stdin) {
      lines = stdin;
    } else {
      return { error: 'awk: 파일이나 파이프 입력이 필요합니다' };
    }
    const output = lines.map((line) => {
      if (fieldNum === 0) return line;
      const fields = delim ? line.split(delim) : line.trim().split(/\s+/);
      return fields[fieldNum - 1] !== undefined ? fields[fieldNum - 1] : '';
    });
    return { output };
  }

  function xargsCmd(args, ctx, stdin) {
    if (!stdin) return { error: 'xargs: 파이프 입력이 필요합니다' };
    const cmdName = args[0];
    if (!cmdName) return { error: 'xargs: 실행할 명령어가 필요합니다' };
    const fixedArgs = args.slice(1);
    const fn = COMMANDS[cmdName];
    if (!fn) return { error: `xargs: ${cmdName}: command not found` };
    let combined = [];
    for (const line of stdin) {
      if (!line) continue;
      const result = fn(fixedArgs.concat([line]), ctx, null) || {};
      if (result.error) return { error: result.error };
      combined = combined.concat(result.output || []);
    }
    return { output: combined };
  }

  /* ---------- 서비스 / 시스템 상태 (가상 서비스 목록·고정 테이블 기반) ---------- */
  function systemctlCmd(args, ctx) {
    const action = args[0];
    const svcName = args[1];
    const services = ctx.services || [];
    if (!action) return { error: 'systemctl: usage: systemctl [status|start|stop|restart] <service>' };
    if (!svcName) return { error: 'systemctl: 서비스 이름이 필요합니다' };
    const svc = services.find((s) => s.name === svcName);
    if (!svc) return { error: `Unit ${svcName}.service could not be found.` };
    if (action === 'status') {
      const statusLine = svc.status === 'active' ? 'active (running)' : svc.status === 'failed' ? 'failed (Result: exit-code)' : 'inactive (dead)';
      return { output: [`● ${svc.name}.service`, `   Active: ${statusLine}`] };
    }
    if (action === 'start' || action === 'restart') { svc.status = 'active'; return { output: [] }; }
    if (action === 'stop') { svc.status = 'inactive'; return { output: [] }; }
    if (action === 'enable') { return { output: [`Created symlink /etc/systemd/system/multi-user.target.wants/${svc.name}.service`] }; }
    return { error: `systemctl: unknown action '${action}'` };
  }

  function journalctlCmd(args, ctx) {
    const idx = args.indexOf('-u');
    const svcName = idx !== -1 ? args[idx + 1] : null;
    if (!svcName) return { error: 'journalctl: -u 옵션으로 서비스 이름을 지정해주세요 (예: journalctl -u nginx)' };
    const svc = (ctx.services || []).find((s) => s.name === svcName);
    if (!svc) return { output: ['-- No entries --'] };
    return { output: svc.logs && svc.logs.length ? svc.logs : ['-- No entries --'] };
  }

  function dfCmd(args, ctx) { return { output: ctx.diskOutput || [] }; }
  function duCmd(args, ctx) { return { output: ctx.duOutput || [] }; }
  function freeCmd(args, ctx) { return { output: ctx.memOutput || [] }; }

  function whoamiCmd() { return { output: ['user'] }; }
  function clearCmd() { return { output: [], clear: true }; }

  const MAN_PAGES = {
    pwd: 'pwd - 현재 작업 디렉터리의 절대 경로를 출력합니다.',
    ls: 'ls [-a] [-l] [경로] - 디렉터리 내용을 나열합니다. -a: 숨김 파일 포함, -l: 상세 정보(권한) 포함',
    cd: 'cd [경로] - 지정한 경로로 이동합니다. 경로 생략 시 홈 디렉터리(~)로 이동',
    cat: 'cat 파일 [파일...] - 파일 내용을 화면에 출력합니다.',
    echo: 'echo 문자열 [> 또는 >> 파일] - 문자열을 출력하거나, 리다이렉션으로 파일에 씁니다.',
    mkdir: 'mkdir [-p] 디렉터리 - 새 디렉터리를 생성합니다.',
    touch: 'touch 파일 - 빈 파일을 생성합니다(이미 있으면 변화 없음).',
    rm: 'rm [-r] [-f] 대상 - 파일을 삭제합니다. -r: 디렉터리 재귀 삭제, -f: 에러 무시',
    cp: 'cp [-r] 원본 대상 - 파일이나(-r 옵션 시) 디렉터리를 복사합니다.',
    mv: 'mv 원본 대상 - 파일/디렉터리를 이동하거나 이름을 변경합니다.',
    grep: 'grep [-i] [-r] 패턴 [파일] - 파일에서 패턴이 포함된 줄을 찾습니다. -i: 대소문자 무시, -r: 폴더 전체 재귀 검색',
    find: 'find 경로 [-name 패턴] [-type f|d] - 경로 하위 전체에서 이름/종류가 일치하는 항목을 찾습니다.',
    chmod: 'chmod 모드 파일 - 파일 권한을 변경합니다. (예: chmod 755 file, chmod u+x file)',
    wc: 'wc [-l|-w|-c] 파일 - 파일의 줄 수/단어 수/문자 수를 셉니다.',
    head: 'head [-n N] 파일 - 파일의 앞부분 N줄(기본 10줄)을 출력합니다.',
    tail: 'tail [-n N] 파일 - 파일의 마지막 N줄(기본 10줄)을 출력합니다.',
    sort: 'sort [-r] [-n] 파일 - 줄을 정렬합니다. -r: 역순, -n: 숫자로 정렬',
    uniq: 'uniq [-c] 파일 - 바로 위 줄과 같은 중복 줄을 제거합니다. (보통 sort와 함께 사용) -c: 중복 횟수 표시',
    ps: 'ps aux - 실행 중인 프로세스를 CPU/메모리 사용률과 함께 표시합니다.',
    kill: 'kill [-9] PID - 프로세스를 종료합니다. -9(SIGKILL): 강제 종료',
    netstat: 'netstat -tlnp / ss -tlnp - 현재 열려있는(listen) 포트와 프로세스를 표시합니다.',
    lsof: 'lsof -i :포트 - 특정 포트를 점유 중인 프로세스를 찾습니다.',
    curl: 'curl [-I] URL - HTTP 요청을 보내 응답을 확인합니다. -I: 헤더(상태 코드)만 확인',
    sleep: 'sleep N - N초간 대기합니다. (백그라운드 실행 연습용 예제 명령어)',
    nohup: 'nohup 명령어 & - 세션이 끊겨도(SIGHUP) 죽지 않도록 명령을 실행합니다. 보통 &와 함께 씁니다.',
    jobs: 'jobs - &로 실행한 백그라운드 작업 목록을 표시합니다.',
    sed: "sed 's/찾을값/바꿀값/[g]' 파일 - 문자열을 치환해서 출력합니다.",
    awk: "awk [-F구분자] '{print $N}' 파일 - 구분자로 나눈 N번째 값만 추출합니다.",
    xargs: '명령1 | xargs 명령2 - 앞 명령의 출력 각각에 대해 명령2를 반복 실행합니다.',
    systemctl: 'systemctl [status|start|stop|restart] 서비스명 - systemd 서비스를 관리합니다.',
    journalctl: 'journalctl -u 서비스명 - 특정 서비스의 상세 로그를 확인합니다.',
    df: 'df -h - 디스크 파티션별 사용 용량을 확인합니다.',
    du: 'du -sh 경로 - 폴더별 사용 용량을 확인합니다.',
    free: 'free -m - 메모리 사용량을 확인합니다.',
    whoami: 'whoami - 현재 로그인한 사용자 이름을 출력합니다.',
    clear: 'clear - 터미널 화면을 지웁니다.',
    help: 'help - 사용 가능한 명령어 목록을 보여줍니다.',
    man: 'man 명령어 - 명령어에 대한 설명서를 봅니다.',
    history: 'history - 지금까지 입력한 명령어 기록을 보여줍니다.',
  };

  function helpCmd() {
    return { output: Object.values(MAN_PAGES) };
  }
  function manCmd(args) {
    const c = args[0];
    const d = MAN_PAGES[c];
    return { output: d ? [d] : [`해당 명령어에 대한 매뉴얼이 없습니다: ${c}`] };
  }
  function historyCmd(args, ctx) {
    return { output: ctx.history.map((h, i) => `${i + 1}  ${h}`) };
  }

  const COMMANDS = {
    pwd: pwdCmd, ls: lsCmd, cd: cdCmd, cat: catCmd, echo: echoCmd,
    mkdir: mkdirCmd, touch: touchCmd, rm: rmCmd, cp: cpCmd, mv: mvCmd,
    grep: grepCmd, find: findCmd, chmod: chmodCmd, wc: wcCmd,
    head: headCmd, tail: tailCmd, sort: sortCmd, uniq: uniqCmd,
    ps: psCmd, kill: killCmd, netstat: netstatCmd, ss: netstatCmd, lsof: lsofCmd,
    curl: curlCmd, sleep: sleepCmd, nohup: nohupCmd, jobs: jobsCmd,
    sed: sedCmd, awk: awkCmd, xargs: xargsCmd,
    systemctl: systemctlCmd, journalctl: journalctlCmd, df: dfCmd, du: duCmd, free: freeCmd,
    whoami: whoamiCmd, clear: clearCmd, help: helpCmd, man: manCmd, history: historyCmd,
  };

  /* ============================================================
   * 실행 엔진 (파이프 / 리다이렉션 지원)
   * ========================================================== */
  function writeToFile(ctx, filePath, content, append) {
    const segs = resolvePath(ctx.cwd, filePath);
    const name = segs.pop();
    const parent = getNode(ctx.root, segs);
    if (!parent || parent.type !== 'dir') return;
    let node = parent.children[name];
    if (!node) { node = F(''); parent.children[name] = node; }
    if (node.type === 'dir') return;
    node.content = append ? (node.content ? node.content + '\n' + content : content) : content;
  }

  function executePipeline(raw, ctx) {
    const stages = raw.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
    let stdin = null;
    let finalOutput = [];
    let error = null;
    let clear = false;
    let lastCmdName = null;
    let lastArgs = [];

    for (let i = 0; i < stages.length; i++) {
      const isLast = i === stages.length - 1;
      let tokens = tokenize(stages[i]);
      let targetFile = null;
      let appendMode = false;
      if (isLast) {
        const gtIdx = tokens.findIndex((t) => t === '>' || t === '>>');
        if (gtIdx !== -1) {
          appendMode = tokens[gtIdx] === '>>';
          targetFile = tokens[gtIdx + 1];
          tokens = tokens.slice(0, gtIdx);
        }
      }
      if (tokens.length === 0) { error = 'syntax error near unexpected token'; break; }
      const cmdName = tokens[0];
      const cmdArgs = tokens.slice(1);
      lastCmdName = cmdName;
      lastArgs = cmdArgs;
      const fn = COMMANDS[cmdName];
      if (!fn) { error = `${cmdName}: command not found`; break; }
      const result = fn(cmdArgs, ctx, stdin) || {};
      if (result.error) { error = result.error; break; }
      if (result.clear) clear = true;
      finalOutput = result.output || [];
      stdin = finalOutput;
      if (isLast && targetFile) {
        writeToFile(ctx, targetFile, finalOutput.join('\n'), appendMode);
        finalOutput = [];
      }
    }

    return { output: finalOutput, error, clear, cmdName: lastCmdName, args: lastArgs, raw };
  }

  /* &&, ; 로 여러 명령을 한 줄에 이어붙이는 체이닝. &&는 앞 명령이 성공해야 다음을 실행, ;는 항상 다음을 실행.
     맨 끝에 단독 & 가 붙으면 백그라운드 작업(jobs)으로 등록한다. */
  function executeChain(raw, ctx) {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    ctx.history.push(trimmed);

    let execLine = trimmed;
    let background = false;
    if (execLine.endsWith('&') && !execLine.endsWith('&&')) {
      background = true;
      execLine = execLine.slice(0, -1).trim();
    }

    const parts = execLine.split(/(&&|;)/).map((s) => s.trim()).filter((s) => s.length > 0);
    const segments = [];
    let skipDueToError = false;
    let pendingSep = null;
    for (const part of parts) {
      if (part === '&&' || part === ';') { pendingSep = part; continue; }
      if (pendingSep === '&&' && skipDueToError) { pendingSep = null; continue; }
      const segResult = executePipeline(part, ctx);
      segments.push(segResult);
      skipDueToError = !!segResult.error;
      pendingSep = null;
    }

    let backgroundJob = null;
    if (background && segments.length > 0 && !skipDueToError) {
      ctx.jobs = ctx.jobs || [];
      backgroundJob = { id: ctx.jobs.length + 1, pid: 10000 + ctx.jobs.length, cmd: execLine };
      ctx.jobs.push(backgroundJob);
    }

    return { segments, raw: trimmed, backgroundJob };
  }

  /* ============================================================
   * 미션 데이터
   * ========================================================== */
  const MISSIONS = [
    {
      id: 'pwd', title: '1화. 여기가 어디지?', difficulty: 'easy',
      desc: '팀장: "서버 접속했으면 제일 먼저 네가 어디 있는지부터 확인해야지. pwd 명령어로 현재 위치(경로)를 출력해봐."',
      fs: {},
      hints: ['pwd는 Print Working Directory의 약자예요.', '터미널에 pwd 를 입력하고 Enter를 눌러보세요.'],
      commandsTaught: [{ cmd: 'pwd', desc: '현재 작업 디렉터리의 절대 경로 출력' }],
      check: (s) => s.cmdName === 'pwd' && !s.error,
    },
    {
      id: 'ls', title: '2화. 뭐가 있는지 봐야지', difficulty: 'easy',
      desc: '팀장: "이 폴더 안에 어떤 파일들이 있는지 목록을 좀 보여줘."',
      fs: { 'notice.txt': F('오늘자 배포 공지입니다.'), 'todo.txt': F('1. 로그 확인\n2. 백업 폴더 정리') },
      hints: ['ls 명령어를 입력해보세요.'],
      commandsTaught: [{ cmd: 'ls', desc: '현재 디렉터리의 파일/폴더 목록 출력' }],
      check: (s) => s.cmdName === 'ls' && !s.error,
    },
    {
      id: 'ls-a', title: '3화. 숨겨진 게 있다던데', difficulty: 'easy',
      desc: '팀장: "이 서버에 설정 파일이 하나 숨겨져 있을 거야. 기본 ls로는 안 보여. 숨김 파일까지 보는 옵션을 써봐." (숨김 파일은 이름이 점(.)으로 시작해요)',
      fs: { 'readme.txt': F('평범한 파일'), '.env': F('DB_PASSWORD=hunter2') },
      hints: ['ls -a 를 사용하면 점(.)으로 시작하는 숨김 파일도 보여줍니다.'],
      commandsTaught: [{ cmd: 'ls -a', desc: '숨김 파일(.으로 시작)까지 모두 표시' }],
      check: (s) => s.cmdName === 'ls' && s.args.includes('-a') && s.output.some((l) => l.includes('.env')),
    },
    {
      id: 'cd', title: '4화. 작업 폴더로 이동', difficulty: 'easy',
      desc: '팀장: "오늘 작업할 프로젝트는 projects/api-server 폴더에 있어. 거기로 이동해줘."',
      fs: { projects: D({ 'api-server': D({}), 'batch-server': D({}) }) },
      hints: ['cd projects 로 먼저 이동한 뒤, cd api-server 로 더 들어갈 수 있어요.', '한 번에 이동하려면 cd projects/api-server 처럼 경로를 이어서 써도 됩니다.'],
      commandsTaught: [{ cmd: 'cd 경로', desc: '해당 경로로 디렉터리 이동' }],
      check: (s) => arraysEqual(s.ctx.cwd, HOME_PATH.concat(['projects', 'api-server'])),
    },
    {
      id: 'cat', title: '5화. 이 파일 내용이 뭐야', difficulty: 'easy',
      desc: '팀장: "config.txt 파일 안에 접속 정보가 적혀 있을 거야. 내용 좀 확인해줘."',
      fs: { 'config.txt': F('HOST=192.168.0.10\nPORT=8080\nENV=production') },
      hints: ['cat 파일명 으로 파일 내용을 화면에 출력할 수 있어요.'],
      commandsTaught: [{ cmd: 'cat 파일', desc: '파일 내용을 화면에 출력' }],
      check: (s) => s.cmdName === 'cat' && s.args.includes('config.txt') && !s.error,
    },
    {
      id: 'mkdir', title: '6화. 백업 폴더 만들기', difficulty: 'easy',
      desc: '팀장: "배포 전에 백업용 폴더 하나 만들어놔. 이름은 backup 으로."',
      fs: {},
      hints: ['mkdir 폴더이름 으로 새 디렉터리를 만들 수 있어요.'],
      commandsTaught: [{ cmd: 'mkdir 이름', desc: '새 디렉터리(폴더) 생성' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'backup'); return !!n && n.type === 'dir'; },
    },
    {
      id: 'touch', title: '7화. 로그 파일 미리 만들기', difficulty: 'easy',
      desc: '팀장: "오늘 배치 스크립트가 쓸 로그 파일을 미리 만들어놔야 해. batch.log 파일 하나 생성해줘."',
      fs: {},
      hints: ['touch 파일이름 으로 빈 파일을 만들 수 있어요.'],
      commandsTaught: [{ cmd: 'touch 파일', desc: '빈 파일 생성(이미 있으면 무시)' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'batch.log'); return !!n && n.type === 'file'; },
    },
    {
      id: 'echo-redirect', title: '8화. 설정값 기록하기', difficulty: 'medium',
      desc: '팀장: "deploy.env 파일을 만들고 그 안에 STAGE=production 이라고 적어놔." (echo와 > 리다이렉션 사용: echo "내용" > 파일명)',
      fs: {},
      hints: ['echo "STAGE=production" > deploy.env 처럼 입력해보세요.', '> 기호는 echo의 출력 결과를 화면 대신 파일에 저장(덮어쓰기)합니다.'],
      commandsTaught: [{ cmd: 'echo "내용" > 파일', desc: '문자열을 파일에 써서 저장(덮어쓰기)' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'deploy.env'); return !!n && n.type === 'file' && n.content.trim() === 'STAGE=production'; },
    },
    {
      id: 'echo-append', title: '9화. 한 줄 더 추가하기', difficulty: 'medium',
      desc: '팀장: "deploy.env에 REGION=ap-northeast-2 한 줄 더 추가해줘. 기존 내용은 지우면 안 돼!" (>> 를 쓰면 덮어쓰지 않고 맨 아래에 추가됩니다)',
      fs: { 'deploy.env': F('STAGE=production') },
      hints: ['echo "REGION=ap-northeast-2" >> deploy.env 처럼 입력해보세요.', '>는 덮어쓰기, >>는 이어쓰기라는 점을 기억하세요.'],
      commandsTaught: [{ cmd: 'echo "내용" >> 파일', desc: '문자열을 파일 맨 끝에 추가(이어쓰기)' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'deploy.env'); return !!n && n.content.replace(/\r/g, '') === 'STAGE=production\nREGION=ap-northeast-2'; },
    },
    {
      id: 'cp', title: '10화. 설정 파일 복사', difficulty: 'easy',
      desc: '팀장: "config.txt를 config.txt.bak 이라는 이름으로 백업 복사본을 만들어놔."',
      fs: { 'config.txt': F('HOST=192.168.0.10\nPORT=8080') },
      hints: ['cp 원본파일 복사할파일명'],
      commandsTaught: [{ cmd: 'cp 원본 대상', desc: '파일(또는 -r 옵션으로 폴더)을 복사' }],
      check: (s) => {
        const orig = getNodeFromHome(s.ctx, 'config.txt');
        const copy = getNodeFromHome(s.ctx, 'config.txt.bak');
        return !!orig && !!copy && copy.type === 'file' && copy.content === orig.content;
      },
    },
    {
      id: 'mv', title: '11화. 파일 이름 정리', difficulty: 'easy',
      desc: '팀장: "draft_report.txt는 이제 최종본이니까 이름을 final_report.txt로 바꿔줘." (mv는 이동뿐 아니라 이름 변경에도 사용돼요)',
      fs: { 'draft_report.txt': F('2026년 상반기 실적 보고서') },
      hints: ['mv 원래이름 새이름'],
      commandsTaught: [{ cmd: 'mv 원본 대상', desc: '파일/폴더를 이동하거나 이름 변경' }],
      check: (s) => {
        const old = getNodeFromHome(s.ctx, 'draft_report.txt');
        const now = getNodeFromHome(s.ctx, 'final_report.txt');
        return !old && !!now && now.type === 'file';
      },
    },
    {
      id: 'rm', title: '12화. 임시 파일 삭제', difficulty: 'easy',
      desc: '팀장: "temp_cache.tmp 파일은 이제 필요 없으니까 지워버려."',
      fs: { 'temp_cache.tmp': F('임시 데이터'), 'important.txt': F('지우면 안 되는 파일') },
      hints: ['rm 파일이름'],
      commandsTaught: [{ cmd: 'rm 파일', desc: '파일 삭제' }],
      check: (s) => !getNodeFromHome(s.ctx, 'temp_cache.tmp') && !!getNodeFromHome(s.ctx, 'important.txt'),
    },
    {
      id: 'rm-r', title: '13화. 옛날 폴더 통째로 삭제', difficulty: 'medium',
      desc: '팀장: "old_version 폴더 안에 있는 옛날 소스들 이제 다 필요없어. 폴더째로 지워줘." (일반 rm으로는 폴더를 못 지웁니다)',
      fs: { old_version: D({ 'app.js': F('legacy code'), 'style.css': F('legacy style') }) },
      hints: ['rm -r 폴더이름', '폴더는 rm만으로 지울 수 없고 -r(재귀) 옵션이 꼭 필요해요.'],
      commandsTaught: [{ cmd: 'rm -r 폴더', desc: '폴더(디렉터리)를 내용물까지 통째로 삭제' }],
      check: (s) => !getNodeFromHome(s.ctx, 'old_version'),
    },
    {
      id: 'grep', title: '14화. 에러 로그 찾기', difficulty: 'medium',
      desc: '팀장: "어제 배포하고 나서 에러 났다는 얘기가 있어. server.log에서 ERROR가 포함된 줄만 뽑아봐."',
      fs: { 'server.log': F('INFO Starting server\nINFO Listening on port 8080\nERROR Connection refused to DB\nINFO Health check ok\nERROR Timeout while calling payment API') },
      hints: ['grep ERROR server.log', 'grep 찾을단어 파일명 형태로 사용해요.'],
      commandsTaught: [{ cmd: 'grep 패턴 파일', desc: '파일에서 특정 문자열이 포함된 줄만 찾기' }],
      check: (s) => s.cmdName === 'grep' && s.output.length > 0 && s.output.every((l) => l.includes('ERROR')),
    },
    {
      id: 'find', title: '15화. 파일이 어디 있는지 찾기', difficulty: 'medium',
      desc: '팀장: "누가 treasure.txt 파일을 어디 폴더에 뒀는지 까먹었대. 폴더 구조 전체에서 그 파일 좀 찾아줘."',
      fs: { src: D({ main: D({ 'utils.js': F('...'), deep: D({ 'treasure.txt': F('여기 숨어있었다!') }) }) }), docs: D({ 'readme.md': F('...') }) },
      hints: ['find . -name "treasure.txt"', 'find 검색시작경로 -name "찾을파일명" 형태로 사용해요. .은 현재 위치를 의미합니다.'],
      commandsTaught: [{ cmd: 'find 경로 -name 이름', desc: '폴더 구조 전체에서 이름으로 파일 찾기' }],
      check: (s) => s.cmdName === 'find' && s.output.some((l) => l.endsWith('treasure.txt')),
    },
    {
      id: 'chmod', title: '16화. 실행 권한 주기', difficulty: 'medium',
      desc: '팀장: "deploy.sh 스크립트를 실행하려는데 권한이 없다고 뜨네. 소유자(owner)한테 실행 권한을 추가해줘." (ls -l 로 현재 권한을 확인할 수 있어요)',
      fs: { 'deploy.sh': F('#!/bin/bash\necho deploying...', 'rw-r--r--') },
      hints: ['chmod 700 deploy.sh 처럼 숫자로 권한을 바꾸거나, chmod u+x deploy.sh 처럼 소유자에게 실행권한(x)만 추가할 수도 있어요.', 'ls -l 로 권한이 바뀌었는지 확인해보세요.'],
      commandsTaught: [{ cmd: 'chmod 권한 파일', desc: '파일의 읽기/쓰기/실행 권한 변경' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'deploy.sh'); return !!n && n.perm[2] === 'x'; },
    },
    {
      id: 'wc', title: '17화. 줄 수 세기', difficulty: 'easy',
      desc: '팀장: "access.log에 로그가 몇 줄이나 쌓였는지 세어봐. 하나하나 세지 말고."',
      fs: { 'access.log': F(Array.from({ length: 37 }, (_, i) => `192.168.0.${i % 255} GET /api/users 200`).join('\n')) },
      hints: ['wc -l 파일명', 'wc는 word count의 약자지만 -l 옵션을 주면 줄(line) 수만 세줍니다.'],
      commandsTaught: [{ cmd: 'wc -l 파일', desc: '파일의 줄 수 세기' }],
      check: (s) => {
        if (s.cmdName !== 'wc') return false;
        const n = getNodeFromHome(s.ctx, 'access.log');
        const expected = n.content.split('\n').length;
        return s.output.some((l) => l.trim().startsWith(String(expected)));
      },
    },
    {
      id: 'pipe', title: '18화. 최종 미션: 파이프 연결하기', difficulty: 'hard',
      desc: '팀장: "마지막이야. access.log에서 404 에러가 몇 번 발생했는지, 파일을 열어보지 말고 명령어 하나로(파이프로 연결해서) 한 번에 구해봐." (| 기호로 명령어의 출력을 다음 명령어의 입력으로 연결할 수 있어요)',
      fs: { 'access.log': F(['GET /api 200', 'GET /login 404', 'GET /home 200', 'GET /missing 404', 'GET /api 500', 'GET /old 404', 'GET /health 200'].join('\n')) },
      hints: ['cat access.log | grep 404 | wc -l', '파이프(|)는 앞 명령어의 출력 결과를 뒷 명령어의 입력으로 그대로 넘겨줍니다.'],
      commandsTaught: [{ cmd: '명령어1 | 명령어2', desc: '파이프: 앞 명령어의 결과를 다음 명령어의 입력으로 전달' }],
      check: (s) => {
        if (!s.raw.includes('|')) return false;
        const n = getNodeFromHome(s.ctx, 'access.log');
        const expected = n.content.split('\n').filter((l) => l.includes('404')).length;
        return s.output.some((l) => l.trim() === String(expected));
      },
    },
    {
      id: 'ls-l', title: '19화. 권한을 눈으로 확인하기', difficulty: 'medium',
      desc: '팀장: "deploy.sh랑 backup.sh 둘 다 있는데, 파일을 열어보지 말고 어떤 파일에 실행 권한이 있는지 목록으로 확인해봐." (ls -l 은 각 파일의 종류(d/-)와 권한(rwx)을 함께 보여줘요)',
      fs: { 'deploy.sh': F('#!/bin/bash\necho deploy', 'rwxr-xr-x'), 'backup.sh': F('#!/bin/bash\necho backup', 'rw-r--r--') },
      hints: ['ls -l 을 입력해보세요.', '맨 앞 10글자가 타입+권한이에요. 예: -rwxr-xr-x 이면 실행(x) 권한이 있는 파일입니다.'],
      commandsTaught: [{ cmd: 'ls -l', desc: '파일 종류(d/-)와 권한(rwx)을 함께 표시' }],
      check: (s) => s.cmdName === 'ls' && s.args.includes('-l') && !s.error,
    },
    {
      id: 'mkdir-p', title: '20화. 폴더 구조 한 번에 만들기', difficulty: 'medium',
      desc: '팀장: "배포 릴리즈 폴더 구조를 releases/2026/v1 이렇게 3단계로 만들어야 하는데, 중간 폴더가 하나도 없어. 중간 경로 없다고 에러 내지 말고 한 번에 만드는 옵션을 써봐."',
      fs: {},
      hints: ['mkdir -p releases/2026/v1', '-p 옵션은 중간 경로 폴더가 없어도 한 번에 다 만들어줘요(parents).'],
      commandsTaught: [{ cmd: 'mkdir -p 경로', desc: '중간 경로가 없어도 한 번에 중첩 디렉터리 생성' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'releases/2026/v1'); return !!n && n.type === 'dir'; },
    },
    {
      id: 'cp-r', title: '21화. 폴더째로 백업하기', difficulty: 'medium',
      desc: '팀장: "static 폴더 안에 있는 파일들이 중요한데, 배포 전에 static_backup 이라는 이름으로 폴더째 복사해놔. 파일 하나하나 복사하지 말고 폴더 통째로."',
      fs: { static: D({ 'logo.png': F('binary-data'), 'main.css': F('body{}') }) },
      hints: ['cp -r static static_backup', '폴더를 복사할 때는 -r(재귀) 옵션이 꼭 필요해요.'],
      commandsTaught: [{ cmd: 'cp -r 원본폴더 대상폴더', desc: '디렉터리를 하위 파일까지 통째로 복사' }],
      check: (s) => {
        const orig = getNodeFromHome(s.ctx, 'static');
        const copy = getNodeFromHome(s.ctx, 'static_backup');
        return !!orig && !!copy && copy.type === 'dir' && !!copy.children['logo.png'] && !!copy.children['main.css'];
      },
    },
    {
      id: 'rm-f', title: '22화. 있어도 없어도 안전하게 지우기', difficulty: 'medium',
      desc: '팀장: "배포 스크립트에 temp.lock 파일 지우는 코드가 들어가는데, 어떤 서버는 이 파일이 있고 어떤 서버는 없어. 파일이 없어도 에러 없이 넘어가게 지워봐." (rm은 대상이 없으면 에러를 냅니다. -f 옵션을 쓰면 에러 없이 조용히 넘어가요)',
      fs: {},
      hints: ['rm -f temp.lock', '-f(force) 옵션은 삭제할 대상이 없어도 에러를 내지 않아요. 배포 스크립트에서 자주 씁니다.'],
      commandsTaught: [{ cmd: 'rm -f 파일', desc: '대상이 없어도 에러 없이 넘어가는 안전한 삭제(스크립트용)' }],
      check: (s) => s.cmdName === 'rm' && s.args.includes('-f') && s.args.includes('temp.lock') && !s.error,
    },
    {
      id: 'chmod-755', title: '23화. 팀 전체가 실행할 수 있게', difficulty: 'hard',
      desc: '팀장: "deploy_all.sh는 팀원 전체가 실행할 수 있어야 해. 근데 내용을 수정할 수 있는 건 소유자만 되게. 숫자 권한 755로 바꿔줘."',
      fs: { 'deploy_all.sh': F('#!/bin/bash', 'rw-r--r--') },
      hints: ['chmod 755 deploy_all.sh', '7=rwx(소유자), 5=r-x(그룹), 5=r-x(다른 사용자) 입니다.'],
      commandsTaught: [{ cmd: 'chmod 755 파일', desc: '소유자는 rwx, 그룹/기타는 r-x (실행 스크립트에 자주 사용)' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'deploy_all.sh'); return !!n && n.perm === 'rwxr-xr-x'; },
    },
    {
      id: 'chmod-644', title: '24화. 민감한 설정 파일 잠그기', difficulty: 'hard',
      desc: '팀장: "db_config.yml에 DB 비밀번호가 들어있는데 권한이 너무 풀려있어(rwxrwxrwx). 소유자만 쓰기 가능하고, 나머지는 읽기만 되도록 644로 바꿔줘."',
      fs: { 'db_config.yml': F('password: hunter2', 'rwxrwxrwx') },
      hints: ['chmod 644 db_config.yml', '6=rw-(소유자), 4=r--(그룹), 4=r--(다른 사용자) 입니다. 민감한 설정 파일은 이렇게 권한을 좁혀야 안전해요.'],
      commandsTaught: [{ cmd: 'chmod 644 파일', desc: '소유자만 쓰기 가능, 나머지는 읽기만 (민감한 설정 파일용)' }],
      check: (s) => { const n = getNodeFromHome(s.ctx, 'db_config.yml'); return !!n && n.perm === 'rw-r--r--'; },
    },
    {
      id: 'grep-i', title: '25화. 대소문자 상관없이 찾기', difficulty: 'medium',
      desc: '팀장: "이 로그는 개발자마다 제각각으로 남겨서 error, Error, ERROR가 섞여 있어. 대소문자 구분 없이 다 찾아줘."',
      fs: { 'mixed.log': F('info boot ok\nError: db timeout\nWARN low memory\nERROR disk full\nerror: retry failed\ninfo done') },
      hints: ['grep -i error mixed.log', '-i(ignore case) 옵션을 쓰면 대소문자를 구분하지 않고 검색합니다.'],
      commandsTaught: [{ cmd: 'grep -i 패턴 파일', desc: '대소문자를 구분하지 않고 검색' }],
      check: (s) => {
        if (s.cmdName !== 'grep' || !s.args.includes('-i')) return false;
        const n = getNodeFromHome(s.ctx, 'mixed.log');
        const expected = n.content.split('\n').filter((l) => l.toLowerCase().includes('error'));
        return s.output.length > 0 && s.output.length === expected.length;
      },
    },
    {
      id: 'grep-r', title: '26화. 폴더 전체 뒤지기', difficulty: 'hard',
      desc: '팀장: "logs 폴더 밑에 날짜별 하위 폴더가 나뉘어 있는데, 그 안 전체에서 FATAL 이라는 단어가 있는 줄을 다 찾아줘. 폴더를 하나하나 들어가지 말고 한 번에."',
      fs: { logs: D({ '2026-08-13': D({ 'app.log': F('INFO start\nWARN cache miss') }), '2026-08-14': D({ 'app.log': F('INFO start\nFATAL out of memory') }), '2026-08-15': D({ 'app.log': F('INFO start\nFATAL disk crashed\nINFO retrying') }) }) },
      hints: ['grep -r FATAL logs', '-r(recursive) 옵션을 쓰면 폴더 하위 전체 파일을 다 뒤져서 찾아줍니다.'],
      commandsTaught: [{ cmd: 'grep -r 패턴 폴더', desc: '폴더 하위 전체 파일에서 재귀적으로 검색' }],
      check: (s) => s.cmdName === 'grep' && (s.args.includes('-r') || s.args.includes('-R')) && s.output.length === 2 && s.output.every((l) => l.includes('FATAL')),
    },
    {
      id: 'find-type', title: '27화. 폴더만 골라내기', difficulty: 'medium',
      desc: '팀장: "projects2 폴더 밑에 파일이랑 폴더가 섞여 있는데, 폴더(디렉터리) 목록만 뽑아줘. 파일은 빼고."',
      fs: { projects2: D({ api: D({}), batch: D({}), 'readme.md': F('...'), 'config.json': F('{}') }) },
      hints: ['find projects2 -type d', '-type d 는 디렉터리(폴더)만, -type f는 파일만 걸러줍니다.'],
      commandsTaught: [{ cmd: 'find 경로 -type d', desc: '디렉터리(폴더)만 필터링해서 찾기 (-type f는 파일만)' }],
      check: (s) => {
        if (s.cmdName !== 'find' || !s.args.includes('-type')) return false;
        const names = s.output.map((p) => p.split('/').pop());
        return s.output.length === 2 && names.includes('api') && names.includes('batch');
      },
    },
    {
      id: 'head', title: '28화. 앞부분만 빠르게 확인하기', difficulty: 'easy',
      desc: '팀장: "server_list.txt에 서버 100대 목록이 쭉 적혀 있는데, 전체 다 볼 필요 없고 처음 5개만 확인하고 싶어."',
      fs: { 'server_list.txt': F(Array.from({ length: 100 }, (_, i) => `server-${String(i + 1).padStart(3, '0')}`).join('\n')) },
      hints: ['head -n 5 server_list.txt', 'head는 파일의 앞부분(기본 10줄)을 보여줍니다. -n 숫자로 줄 수를 지정할 수 있어요.'],
      commandsTaught: [{ cmd: 'head -n N 파일', desc: '파일의 앞부분 N줄만 출력(기본 10줄)' }],
      check: (s) => {
        if (s.cmdName !== 'head') return false;
        const n = getNodeFromHome(s.ctx, 'server_list.txt');
        const expected = n.content.split('\n').slice(0, 5);
        return s.output.length === 5 && s.output.join('\n') === expected.join('\n');
      },
    },
    {
      id: 'tail', title: '29화. 최신 로그만 빠르게 확인하기', difficulty: 'easy',
      desc: '팀장: "배포 로그가 엄청 쌓였는데, 방금 배포가 성공했는지만 빨리 알고 싶어. 마지막 5줄만 보여줘."',
      fs: { 'deploy_history.log': F(Array.from({ length: 50 }, (_, i) => (i === 49 ? 'STEP 50 DEPLOY SUCCESS' : `STEP ${i + 1} running...`)).join('\n')) },
      hints: ['tail -n 5 deploy_history.log', 'tail은 파일의 끝부분(기본 10줄)을 보여줍니다. 실시간 로그 확인할 때 자주 써요.'],
      commandsTaught: [{ cmd: 'tail -n N 파일', desc: '파일의 마지막 N줄만 출력(기본 10줄)' }],
      check: (s) => {
        if (s.cmdName !== 'tail') return false;
        const n = getNodeFromHome(s.ctx, 'deploy_history.log');
        const expected = n.content.split('\n').slice(-5);
        return s.output.length === 5 && s.output.join('\n') === expected.join('\n');
      },
    },
    {
      id: 'sort-uniq', title: '30화. 중복 없는 접속자 목록 뽑기', difficulty: 'hard',
      desc: '팀장: "access_ip.log에 접속 IP가 순서 없이 막 쌓여있는데, 중복 제거하고 어떤 IP들이 접속했는지 목록만 뽑아줘." (uniq는 "바로 위 줄"과 같을 때만 중복 제거를 해요. 그래서 먼저 정렬을 해야 합니다)',
      fs: { 'access_ip.log': F(['10.0.0.2', '10.0.0.1', '10.0.0.3', '10.0.0.1', '10.0.0.2', '10.0.0.1', '10.0.0.3'].join('\n')) },
      hints: ['sort access_ip.log | uniq', 'uniq는 정렬 없이 쓰면 제대로 중복 제거가 안 돼요. sort로 먼저 순서를 맞춰야 합니다.'],
      commandsTaught: [{ cmd: 'sort 파일 | uniq', desc: '정렬 후 인접한 중복 줄 제거 → 중복 없는 목록 만들기' }],
      check: (s) => {
        if (!s.raw.includes('|')) return false;
        const n = getNodeFromHome(s.ctx, 'access_ip.log');
        const expected = Array.from(new Set(n.content.split('\n'))).sort();
        return s.output.join('\n') === expected.join('\n');
      },
    },
    {
      id: 'uniq-c', title: '31화. 몇 번씩 접속했는지 세기', difficulty: 'hard',
      desc: '팀장: "이번엔 목록만 말고, 각 IP가 몇 번씩 접속했는지 횟수까지 같이 보고 싶어."',
      fs: { 'access_ip2.log': F(['10.0.0.5', '10.0.0.5', '10.0.0.9', '10.0.0.5', '10.0.0.9', '10.0.0.1'].join('\n')) },
      hints: ['sort access_ip2.log | uniq -c', '-c 옵션을 uniq에 주면 각 줄이 몇 번 반복됐는지 앞에 숫자로 보여줍니다.'],
      commandsTaught: [{ cmd: 'sort 파일 | uniq -c', desc: '정렬 후 각 줄의 중복 횟수를 세어서 표시' }],
      check: (s) => {
        if (!s.raw.includes('|') || !s.raw.includes('-c')) return false;
        const n = getNodeFromHome(s.ctx, 'access_ip2.log');
        const freq = {};
        n.content.split('\n').forEach((l) => { freq[l] = (freq[l] || 0) + 1; });
        const gotFreq = {};
        s.output.forEach((line) => {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (m) gotFreq[m[2]] = parseInt(m[1], 10);
        });
        const keys = Object.keys(freq);
        return keys.length === Object.keys(gotFreq).length && keys.every((k) => gotFreq[k] === freq[k]);
      },
    },
    {
      id: 'wc-w', title: '32화. 커밋 메시지 길이 확인', difficulty: 'easy',
      desc: '팀장: "commit_message.txt에 커밋 메시지 초안을 써놨는데, 컨벤션상 너무 길면 안 돼. 몇 단어인지 세어봐."',
      fs: { 'commit_message.txt': F('fix login page validation bug and improve error message handling for empty password field') },
      hints: ['wc -w commit_message.txt', 'wc에 -w 옵션을 주면 줄 수 대신 단어(word) 수를 세어줍니다.'],
      commandsTaught: [{ cmd: 'wc -w 파일', desc: '파일의 단어(word) 수 세기' }],
      check: (s) => {
        if (s.cmdName !== 'wc' || !s.args.includes('-w')) return false;
        const n = getNodeFromHome(s.ctx, 'commit_message.txt');
        const expected = n.content.trim().split(/\s+/).length;
        return s.output.some((l) => l.trim().startsWith(String(expected)));
      },
    },
    {
      id: 'chain-mkdir-touch', title: '33화. 명령어 두 개를 한 줄로', difficulty: 'hard',
      desc: '팀장: "매번 폴더 만들고 파일 만들고 두 줄 치기 귀찮지 않아? &&로 이어서 한 줄에 처리하는 법을 배워봐. release 폴더를 만들고, 그 안에 CHANGELOG.md 파일까지 한 줄로 만들어줘."',
      fs: {},
      hints: ['mkdir release && touch release/CHANGELOG.md', '&&는 앞 명령어가 성공했을 때만 뒤 명령어를 실행합니다. 여러 명령을 한 줄로 이어붙일 때 사용해요.'],
      commandsTaught: [{ cmd: '명령어1 && 명령어2', desc: '앞 명령이 성공해야만 뒤 명령을 실행 (여러 명령을 한 줄로 연결)' }],
      check: (s) => {
        if (!s.raw.includes('&&')) return false;
        const dir = getNodeFromHome(s.ctx, 'release');
        const file = getNodeFromHome(s.ctx, 'release/CHANGELOG.md');
        return !!dir && dir.type === 'dir' && !!file && file.type === 'file';
      },
    },
    {
      id: 'chain-cd-ls', title: '34화. 이동하자마자 확인까지', difficulty: 'medium',
      desc: '팀장: "workspace 폴더로 이동하고 나서 바로 그 안의 파일 목록까지 한 줄 명령어로 확인해줘."',
      fs: { workspace: D({ 'main.py': F('print(1)'), 'utils.py': F('...') }) },
      hints: ['cd workspace && ls', '이동 명령(cd)과 확인 명령(ls)을 &&로 이어서 한 번에 실행할 수 있어요.'],
      commandsTaught: [{ cmd: 'cd 경로 && ls', desc: '이동 후 바로 목록 확인을 한 줄로 처리' }],
      check: (s) => {
        if (!s.raw.includes('&&')) return false;
        const inWorkspace = arraysEqual(s.ctx.cwd, HOME_PATH.concat(['workspace']));
        return inWorkspace && s.allOutput.includes('main.py') && s.allOutput.includes('utils.py');
      },
    },
    {
      id: 'final-boss', title: '35화. 최종 보스: 일일 에러 리포트 만들기', difficulty: 'hard',
      desc: '팀장: "오늘 날짜(2026-08-15) 로그 중에서 ERROR가 몇 건인지 세어서, 그 숫자를 daily_report.txt 파일에 저장해줘. 화면에 띄우지 말고 파일로 바로. 파이프와 리다이렉션을 함께 써서 명령어 하나로 처리해봐."',
      fs: { 'today.log': F(['2026-08-15 10:00 INFO boot', '2026-08-15 10:05 ERROR db timeout', '2026-08-14 09:00 ERROR old error', '2026-08-15 11:20 ERROR payment failed', '2026-08-15 12:00 INFO ok', '2026-08-15 13:40 ERROR disk full'].join('\n')) },
      hints: ['grep "2026-08-15" today.log | grep ERROR | wc -l > daily_report.txt', '파이프로 필터링한 결과를 >로 파일에 바로 저장할 수 있어요. cat daily_report.txt 로 잘 저장됐는지 확인해보세요.'],
      commandsTaught: [{ cmd: '명령1 | 명령2 | 명령3 > 파일', desc: '여러 파이프로 처리한 최종 결과를 파일로 저장' }],
      check: (s) => {
        const n = getNodeFromHome(s.ctx, 'daily_report.txt');
        if (!n || n.type !== 'file') return false;
        const src = getNodeFromHome(s.ctx, 'today.log');
        const expected = src.content.split('\n').filter((l) => l.includes('2026-08-15') && l.includes('ERROR')).length;
        return n.content.trim() === String(expected);
      },
    },
    {
      id: 'curl-basic', title: '36화. API 서버 살아있는지 확인', difficulty: 'medium',
      desc: '팀장: "방금 배포한 주문 API 서버(포트 8080)가 잘 떠 있는지 curl로 호출해서 확인해봐."',
      fs: {},
      processes: [{ pid: 2001, name: 'node server.js', port: 8080, cpu: 2.1, mem: 3.4, httpStatus: 200, response: '{"status":"healthy","service":"order-api"}' }],
      hints: ['curl http://localhost:8080', 'curl은 서버에 HTTP 요청을 보내고 응답을 그대로 보여줍니다. 백엔드 개발자가 가장 많이 쓰는 헬스체크 방법이에요.'],
      commandsTaught: [{ cmd: 'curl URL', desc: 'HTTP 요청을 보내고 응답 본문을 확인' }],
      concept: 'API 서버를 배포한 뒤 브라우저 없이도 서버가 살아있는지, 응답이 정상인지 터미널에서 바로 확인하는 게 curl입니다. 실무에서는 배포 스크립트 마지막 단계에 헬스체크 curl을 넣어서 자동으로 성공 여부를 판단하기도 해요.',
      check: (s) => s.cmdName === 'curl' && !s.error && s.output.some((l) => l.includes('healthy')),
    },
    {
      id: 'curl-head', title: '37화. 상태 코드만 빠르게 확인', difficulty: 'medium',
      desc: '팀장: "이번엔 응답 본문 말고, HTTP 상태 코드만 빠르게 확인하고 싶어. -I 옵션 써봐."',
      fs: {},
      processes: [{ pid: 2001, name: 'node server.js', port: 8080, cpu: 2.1, mem: 3.4, httpStatus: 200, response: '{"status":"healthy"}' }],
      hints: ['curl -I http://localhost:8080', '-I 옵션은 응답 본문 없이 헤더(상태 코드 포함)만 보여줍니다. 대량으로 헬스체크할 때 유용해요.'],
      commandsTaught: [{ cmd: 'curl -I URL', desc: '응답 본문 없이 HTTP 헤더(상태 코드)만 확인' }],
      concept: 'HTTP 상태 코드(200=성공, 404=없음, 500=서버 에러)는 API가 정상인지 판단하는 가장 빠른 신호입니다. 응답 본문이 크면 굳이 다 안 받아도 -I로 상태만 빠르게 볼 수 있어요.',
      check: (s) => s.cmdName === 'curl' && s.args.includes('-I') && s.output.some((l) => l.includes('HTTP/1.1')),
    },
    {
      id: 'curl-refused', title: '38화. 연결이 안 될 때', difficulty: 'medium',
      desc: '팀장: "결제 서버가 8081 포트에서 떠 있어야 하는데, curl 날려보니까 뭐라고 나오는지 확인해봐. (이 서버는 지금 안 떠 있어)"',
      fs: {},
      processes: [],
      hints: ['curl http://localhost:8081', 'Connection refused 에러가 뜨면 그 포트에 아무 프로세스도 떠 있지 않다는 뜻이에요. "서버가 안 켜졌다"는 걸 의미하는 아주 흔한 에러입니다.'],
      commandsTaught: [{ cmd: 'curl URL (실패 시)', desc: 'Connection refused = 해당 포트에 아무 서버도 떠 있지 않음' }],
      concept: '"Connection refused"는 배포 후 가장 자주 마주치는 에러 중 하나입니다. 이 메시지가 뜨면 코드 문제가 아니라 애초에 프로세스가 그 포트에서 실행되지 않고 있다는 뜻이니, 로그부터 볼 게 아니라 프로세스가 떠 있는지부터 확인해야 해요.',
      check: (s) => s.cmdName === 'curl' && !!s.error && s.error.includes('Connection refused'),
    },
    {
      id: 'netstat-ports', title: '39화. 지금 열려있는 포트 목록', difficulty: 'medium',
      desc: '팀장: "이 서버에 지금 어떤 서비스들이 떠서 포트를 쓰고 있는지 목록으로 보여줘."',
      fs: {},
      processes: [{ pid: 1001, name: 'nginx', port: 80, cpu: 0.5, mem: 1.2 }, { pid: 2001, name: 'node app.js', port: 3000, cpu: 3.1, mem: 5.0 }, { pid: 3001, name: 'mysqld', port: 3306, cpu: 1.8, mem: 12.4 }],
      hints: ['netstat -tlnp 또는 ss -tlnp', '-t(tcp) -l(listen 중인 것만) -n(숫자로) -p(프로세스 정보) 조합을 자주 씁니다.'],
      commandsTaught: [{ cmd: 'netstat -tlnp / ss -tlnp', desc: '현재 열려있는(listen 중인) 포트와 프로세스 목록 확인' }],
      concept: '서버에 여러 프로세스가 떠 있을 때 "이 포트 누가 쓰고 있지?"를 확인하는 게 시스템 운영의 기본기입니다. netstat은 오래된 도구, ss는 더 빠른 최신 대체 도구인데 둘 다 실무에서 섞어 씁니다.',
      check: (s) => (s.cmdName === 'netstat' || s.cmdName === 'ss') && s.output.some((l) => l.includes('3306')),
    },
    {
      id: 'lsof-port', title: '40화. 이 포트 누가 쓰는거야', difficulty: 'hard',
      desc: '팀장: "3000번 포트를 어떤 프로세스가 물고 있는지 정확히 찾아줘. netstat 말고 lsof로 해봐."',
      fs: {},
      processes: [{ pid: 2001, name: 'node app.js', port: 3000, cpu: 2.0, mem: 4.0 }],
      hints: ['lsof -i :3000', 'lsof는 "List Open Files"의 약자인데, 특정 포트를 누가 점유하고 있는지 찾을 때 자주 씁니다.'],
      commandsTaught: [{ cmd: 'lsof -i :포트', desc: '특정 포트를 점유 중인 프로세스를 정확히 찾기' }],
      concept: 'lsof -i :PORT는 "이 포트 이미 쓰는 중이라 서버가 안 켜져요(Address already in use)" 에러가 났을 때 범인을 찾는 가장 확실한 방법입니다. netstat/ss로 전체 목록을 보는 것보다 특정 포트 하나를 콕 집어 확인할 때 더 편해요.',
      check: (s) => s.cmdName === 'lsof' && !s.error && s.output.some((l) => l.includes('3000')),
    },
    {
      id: 'kill-port-combo', title: '41화. 최종 미션: 좀비 프로세스 처치', difficulty: 'hard',
      desc: '팀장: "재배포하려는데 8080 포트가 이미 사용 중이라고 뜨네. 옛날 프로세스가 안 죽고 남아있는 것 같아. 누가 점유하고 있는지 찾아서 죽여버려."',
      fs: {},
      processes: [{ pid: 5555, name: 'old-server.js', port: 8080, cpu: 0.1, mem: 2.0 }],
      hints: ['lsof -i :8080 (또는 netstat -tlnp) 으로 PID를 먼저 확인하고, kill 5555 로 종료하세요.', 'PID(Process ID)를 알아야 kill로 정확히 그 프로세스만 종료할 수 있어요.'],
      commandsTaught: [{ cmd: 'lsof -i :포트 → kill PID', desc: '포트 점유 프로세스를 찾아서 종료하는 실전 조합' }],
      concept: '"포트가 이미 사용 중입니다(Address already in use)"는 배포 자동화에서 정말 자주 만나는 에러입니다. 실무 대응 순서는 항상 "누가 쓰고 있는지 찾기 → 그 프로세스 종료하기 → 재배포" 순서예요.',
      check: (s) => !(s.ctx.processes || []).some((p) => p.port === 8080),
    },
    {
      id: 'ps-aux', title: '42화. 지금 뭐가 돌고 있는지 확인', difficulty: 'easy',
      desc: '팀장: "서버가 좀 느린 것 같은데, 지금 어떤 프로세스들이 떠서 자원을 쓰고 있는지 확인해봐."',
      fs: {},
      processes: [{ pid: 1001, name: 'nginx', port: 80, cpu: 0.5, mem: 1.2 }, { pid: 2001, name: 'node app.js', port: 3000, cpu: 45.2, mem: 30.1 }, { pid: 3001, name: 'batch-export.sh', cpu: 88.9, mem: 12.0 }],
      hints: ['ps aux', 'ps aux는 지금 실행 중인 모든 프로세스를 CPU/메모리 사용률과 함께 보여줍니다.'],
      commandsTaught: [{ cmd: 'ps aux', desc: '실행 중인 전체 프로세스를 CPU/메모리 사용률과 함께 확인' }],
      concept: 'ps aux는 "서버가 왜 느리지?"라는 질문에 가장 먼저 확인하는 명령어입니다. %CPU, %MEM이 비정상적으로 높은 프로세스를 찾아서 원인을 좁혀나가는 게 장애 대응의 첫 단계예요.',
      check: (s) => s.cmdName === 'ps' && s.args.includes('aux') && !s.error,
    },
    {
      id: 'kill-normal', title: '43화. 프로세스 정상 종료', difficulty: 'medium',
      desc: '팀장: "batch-export.sh(pid 3001)가 CPU를 너무 많이 먹고 있어. 종료해줘."',
      fs: {},
      processes: [{ pid: 3001, name: 'batch-export.sh', cpu: 88.9, mem: 12.0 }],
      hints: ['kill 3001', 'kill은 기본적으로 프로세스에게 "정상적으로 종료해줘"라는 신호(SIGTERM)를 보냅니다.'],
      commandsTaught: [{ cmd: 'kill PID', desc: '프로세스에 정상 종료 신호(SIGTERM) 전송' }],
      concept: '기본 kill은 프로세스에게 "지금까지 하던 작업 정리하고 종료해줘"라고 정중하게 요청하는 것(SIGTERM)입니다. 강제로 끊는 게 아니라서 데이터가 깨질 위험이 적기 때문에, 웬만하면 -9 없이 kill부터 시도하는 게 관례입니다.',
      check: (s) => !(s.ctx.processes || []).some((p) => p.pid === 3001),
    },
    {
      id: 'kill-9', title: '44화. 안 죽는 프로세스 강제 종료', difficulty: 'hard',
      desc: '팀장: "hung-worker(pid 4099)는 일반 kill로는 응답이 없어. 강제로 종료시켜야 해."',
      fs: {},
      processes: [{ pid: 4099, name: 'hung-worker', cpu: 99.0, mem: 40.0, stubborn: true }],
      hints: ['먼저 kill 4099 를 시도해보면 아무 반응이 없을 거예요.', 'kill -9 4099 처럼 -9(SIGKILL) 옵션을 쓰면 프로세스를 강제로 즉시 종료시킵니다.'],
      commandsTaught: [{ cmd: 'kill -9 PID', desc: 'SIGTERM을 무시하는 프로세스를 강제 종료(SIGKILL)' }],
      concept: 'kill -9(SIGKILL)는 프로세스가 정리할 시간도 안 주고 즉시 죽이는 마지막 수단입니다. 행 걸리거나 응답 없는 프로세스에 쓰지만, 파일 쓰기 중이었다면 데이터가 깨질 수 있어서 정말 안 죽을 때만 최후의 수단으로 써야 해요.',
      check: (s) => !(s.ctx.processes || []).some((p) => p.pid === 4099),
    },
    {
      id: 'bg-amp', title: '45화. 오래 걸리는 작업 백그라운드로', difficulty: 'medium',
      desc: '팀장: "이 정리 작업(sleep 100)은 오래 걸려. 터미널이 막히지 않게 백그라운드로 돌려봐."',
      fs: {},
      hints: ['sleep 100 &', '명령어 끝에 & 를 붙이면 백그라운드에서 실행되고, 터미널은 바로 다음 명령을 입력받을 수 있어요.'],
      commandsTaught: [{ cmd: '명령어 &', desc: '명령을 백그라운드로 실행해서 터미널을 막지 않음' }],
      concept: '오래 걸리는 배치 작업이나 서버 프로세스를 &로 백그라운드 실행하면, 그 작업이 끝날 때까지 기다리지 않고 바로 다음 명령을 이어서 칠 수 있습니다. 실무에서 서버를 직접 실행할 때 자주 쓰는 패턴이에요.',
      check: (s) => { const t = s.raw.trim(); return t.endsWith('&') && !t.endsWith('&&') && t.includes('sleep'); },
    },
    {
      id: 'nohup-jobs', title: '46화. 로그아웃해도 안 죽게, 확인까지', difficulty: 'hard',
      desc: '팀장: "SSH 세션이 끊겨도 계속 돌아야 하는 작업이야. nohup까지 같이 써서 백그라운드로 돌리고, jobs로 잘 떴는지 확인해봐."',
      fs: {},
      hints: ['nohup sleep 200 &', '그다음 jobs 를 입력해서 백그라운드 작업 목록을 확인해보세요.'],
      commandsTaught: [{ cmd: 'nohup 명령어 & → jobs', desc: '세션 종료에도 안 죽는 백그라운드 실행 + 작업 목록 확인' }],
      concept: '기본적으로 SSH 접속이 끊기면 그 세션에서 실행한 프로세스도 같이 죽습니다(SIGHUP 신호). nohup은 "이 신호(HUP)를 무시해라"라는 뜻이라서, 배포 서버에 SSH로 접속해서 뭔가 오래 실행시켜놓고 나올 때 자주 씁니다.',
      check: (s) => {
        if (s.cmdName !== 'jobs' || s.output.length === 0 || s.output[0].includes('없습니다')) return false;
        return s.ctx.history.some((h) => { const t = h.trim(); return h.includes('nohup') && t.endsWith('&') && !t.endsWith('&&'); });
      },
    },
    {
      id: 'sed-basic', title: '47화. 문자열 치환 미리보기', difficulty: 'medium',
      desc: '팀장: "nginx.conf에 있는 옛날 도메인을 새 도메인으로 바꾼 결과를 화면에 미리 보여줘 (아직 파일을 진짜로 고치는 건 아니야)."',
      fs: { 'nginx.conf': F('server_name old-domain.com;\nlisten 80;') },
      hints: ["sed 's/old-domain.com/new-domain.com/' nginx.conf", 'sed는 s/찾을문자열/바꿀문자열/ 형태로 텍스트를 치환합니다. 화면에 출력만 할 뿐 파일은 그대로예요.'],
      commandsTaught: [{ cmd: "sed 's/찾을값/바꿀값/' 파일", desc: '파일 내용에서 문자열을 치환해서 출력(파일 자체는 안 바뀜)' }],
      concept: '설정 파일의 특정 값을 서버마다 다르게 바꿔야 할 때(도메인, 포트, 환경변수 등), sed는 배포 스크립트에서 가장 많이 쓰이는 치환 도구입니다. Nginx 설정, docker-compose.yml 같은 파일을 자동으로 고칠 때 자주 등장해요.',
      check: (s) => s.cmdName === 'sed' && !s.error && s.output.some((l) => l.includes('new-domain.com')) && !s.output.some((l) => l.includes('old-domain.com')),
    },
    {
      id: 'awk-column', title: '48화. 로그에서 특정 값만 뽑기', difficulty: 'medium',
      desc: '팀장: "access2.log에서 접속 IP(맨 앞 값)만 쭉 뽑아줘."',
      fs: { 'access2.log': F(['10.0.0.1 GET /api 200', '10.0.0.2 GET /home 200', '10.0.0.3 GET /login 404'].join('\n')) },
      hints: ["awk '{print $1}' access2.log", 'awk는 한 줄을 공백 기준으로 나눠서 $1, $2, $3... 번째 값을 뽑을 수 있어요. 로그에서 특정 컬럼만 추출할 때 정말 많이 씁니다.'],
      commandsTaught: [{ cmd: "awk '{print $N}' 파일", desc: '공백 기준으로 나눈 N번째 값만 추출' }],
      concept: '로그 한 줄에서 IP, 응답시간, 상태 코드처럼 특정 값만 뽑아 통계를 낼 때 awk가 표준 도구입니다. grep이 "줄을 찾는" 도구라면, awk는 "그 줄에서 원하는 조각만 꺼내는" 도구예요.',
      check: (s) => {
        if (s.cmdName !== 'awk') return false;
        const n = getNodeFromHome(s.ctx, 'access2.log');
        const expected = n.content.split('\n').map((l) => l.trim().split(/\s+/)[0]);
        return s.output.length === expected.length && s.output.join('\n') === expected.join('\n');
      },
    },
    {
      id: 'awk-delim', title: '49화. 구분자가 다른 로그 다루기', difficulty: 'medium',
      desc: '팀장: "metrics.csv는 콤마(,)로 값이 구분돼 있어. 세 번째 값(응답시간)만 뽑아줘."',
      fs: { 'metrics.csv': F(['GET,/api,120ms', 'POST,/login,340ms', 'GET,/home,80ms'].join('\n')) },
      hints: ["awk -F, '{print $3}' metrics.csv", '-F 옵션으로 구분자를 지정할 수 있어요. 기본은 공백이지만 콤마(,)나 콜론(:)으로 구분된 로그도 흔합니다.'],
      commandsTaught: [{ cmd: "awk -F구분자 '{print $N}' 파일", desc: '공백이 아닌 다른 구분자(콤마 등) 기준으로 값 추출' }],
      concept: 'CSV 형식 로그나 /etc/passwd 같은 시스템 파일은 공백이 아니라 콤마(,)나 콜론(:)으로 값이 나뉩니다. -F 옵션으로 구분자를 바꿀 수 있다는 걸 알아두면 어떤 형식의 로그를 만나도 당황하지 않아요.',
      check: (s) => {
        if (s.cmdName !== 'awk') return false;
        const n = getNodeFromHome(s.ctx, 'metrics.csv');
        const expected = n.content.split('\n').map((l) => l.split(',')[2]);
        return s.output.length === expected.length && s.output.join('\n') === expected.join('\n');
      },
    },
    {
      id: 'xargs-cleanup', title: '50화. 찾은 파일 한번에 정리', difficulty: 'hard',
      desc: '팀장: "project3 폴더 밑에 .tmp 파일들이 여기저기 흩어져 있는데, 어디 있는지 다 찾아서 한 번에 삭제까지 해줘."',
      fs: { project3: D({ a: D({ 'cache1.tmp': F('x') }), b: D({ 'cache2.tmp': F('y'), 'keep.txt': F('z') }) }) },
      hints: ['find project3 -name "*.tmp" | xargs rm', 'xargs는 앞 명령어의 출력(파일 경로 목록)을 받아서, 그 각각에 대해 rm 같은 명령어를 실행해줍니다.'],
      commandsTaught: [{ cmd: 'find ... | xargs 명령어', desc: '찾은 결과 각각에 대해 명령어를 일괄 실행' }],
      concept: 'find로 파일을 100개 찾았다고 해서 rm을 100번 칠 수는 없죠. xargs는 파이프로 받은 목록 하나하나에 대해 명령어를 자동으로 반복 실행해줘서, "찾아서 한 번에 처리"하는 스크립트의 핵심 조합입니다.',
      check: (s) => {
        const dir = getNodeFromHome(s.ctx, 'project3');
        if (!dir) return false;
        let tmpFound = false;
        (function walk(n) {
          if (n.type === 'dir') { Object.keys(n.children).forEach((k) => { if (k.endsWith('.tmp')) tmpFound = true; walk(n.children[k]); }); }
        })(dir);
        const keep = getNodeFromHome(s.ctx, 'project3/b/keep.txt');
        return !tmpFound && !!keep;
      },
    },
    {
      id: 'grep-awk-combo', title: '51화. 파이프 조합: 필터링 후 값 추출', difficulty: 'hard',
      desc: '팀장: "access2.log에서 404 에러만 골라서, 그 요청을 보낸 IP만 뽑아줘. grep이랑 awk를 파이프로 이어서 한 번에 처리해봐."',
      fs: { 'access2.log': F(['10.0.0.1 GET /api 200', '10.0.0.2 GET /home 200', '10.0.0.3 GET /login 404', '10.0.0.4 GET /old 404'].join('\n')) },
      hints: ["grep 404 access2.log | awk '{print $1}'", '먼저 grep으로 원하는 줄만 걸러내고, 그 결과를 awk에 파이프로 넘겨서 값을 추출하는 조합이에요. 실무 로그 분석에서 정말 자주 쓰는 패턴입니다.'],
      commandsTaught: [{ cmd: "grep 패턴 파일 | awk '{print $N}'", desc: '조건에 맞는 줄만 걸러낸 뒤 필요한 값만 추출' }],
      concept: '실무 로그 분석은 대부분 "먼저 조건으로 줄을 거르고(grep) → 그 중에서 필요한 값만 뽑는다(awk)"의 반복입니다. 이 패턴 하나만 익혀도 웬만한 로그 집계는 셸 한 줄로 끝낼 수 있어요.',
      check: (s) => {
        if (!s.raw.includes('|')) return false;
        const n = getNodeFromHome(s.ctx, 'access2.log');
        const expected = n.content.split('\n').filter((l) => l.includes('404')).map((l) => l.trim().split(/\s+/)[0]);
        return s.output.length > 0 && s.output.join('\n') === expected.join('\n');
      },
    },
    {
      id: 'systemctl-status', title: '52화. 서비스 상태 확인', difficulty: 'medium',
      desc: '팀장: "배포한 API 서버가 systemd 서비스로 잘 등록됐는지, api-server 상태를 확인해봐."',
      fs: {},
      services: [{ name: 'api-server', status: 'active' }],
      hints: ['systemctl status api-server', 'systemctl status는 서비스가 실행 중인지(active), 멈춰있는지(inactive), 죽었는지(failed) 보여줍니다.'],
      commandsTaught: [{ cmd: 'systemctl status 서비스명', desc: '서비스의 현재 실행 상태 확인' }],
      concept: '요즘 리눅스 서버 대부분은 systemd로 서비스(nginx, 우리 API 서버 등)를 관리합니다. 배포 후 "서비스가 정상 등록되고 살아있는지"를 확인하는 게 systemctl status의 역할이에요.',
      check: (s) => s.cmdName === 'systemctl' && s.args.includes('status') && s.args.includes('api-server') && !s.error,
    },
    {
      id: 'systemctl-restart', title: '53화. 죽은 서비스 재기동', difficulty: 'medium',
      desc: '팀장: "nginx가 설정 오류로 죽어있어(failed). 재시작해서 다시 살려줘."',
      fs: {},
      services: [{ name: 'nginx', status: 'failed' }],
      hints: ['systemctl restart nginx', 'restart는 서비스를 멈췄다가 다시 시작합니다. 설정 변경 후에도 반영을 위해 자주 씁니다.'],
      commandsTaught: [{ cmd: 'systemctl restart 서비스명', desc: '서비스를 중지 후 다시 시작(설정 반영, 장애 복구)' }],
      concept: '설정 파일을 고쳤는데 반영이 안 되거나, 서비스가 알 수 없는 이유로 죽어있을 때 가장 먼저 시도하는 게 restart입니다. 물론 왜 죽었는지 로그(journalctl)도 같이 확인하는 습관이 중요해요.',
      check: (s) => {
        const svc = (s.ctx.services || []).find((x) => x.name === 'nginx');
        return !!svc && svc.status === 'active' && s.cmdName === 'systemctl' && s.args.includes('restart');
      },
    },
    {
      id: 'journalctl', title: '54화. 서비스 로그로 원인 찾기', difficulty: 'hard',
      desc: '팀장: "payment-worker가 자꾸 죽는대. 최근 로그를 좀 봐줘."',
      fs: {},
      services: [{ name: 'payment-worker', status: 'failed', logs: ['Aug 15 10:00:01 payment-worker[1234]: Starting worker', 'Aug 15 10:00:05 payment-worker[1234]: FATAL: DB connection refused', 'Aug 15 10:00:05 payment-worker[1234]: Worker exited with code 1'] }],
      hints: ['journalctl -u payment-worker', '-u 옵션으로 특정 서비스의 로그만 골라서 볼 수 있어요. systemctl status보다 훨씬 자세한 로그가 나옵니다.'],
      commandsTaught: [{ cmd: 'journalctl -u 서비스명', desc: '특정 systemd 서비스의 상세 로그 확인' }],
      concept: 'systemctl status는 "지금 죽어있다"는 요약만 보여주지만, 왜 죽었는지는 journalctl로 로그를 봐야 알 수 있습니다. "FATAL: DB connection refused" 같은 실제 에러 메시지가 여기 있어요 — 장애 원인 분석의 시작점입니다.',
      check: (s) => s.cmdName === 'journalctl' && s.args.includes('-u') && s.args.includes('payment-worker') && s.output.length > 0 && !s.error,
    },
    {
      id: 'df-h', title: '55화. 디스크 용량 확인', difficulty: 'medium',
      desc: '팀장: "배포 서버 디스크가 꽉 찼다는 알림이 왔어. 용량 좀 확인해줘."',
      fs: {},
      diskOutput: ['Filesystem      Size  Used Avail Use% Mounted on', '/dev/sda1        50G   48G  1.2G  98% /', 'tmpfs           2.0G     0  2.0G   0% /dev/shm', '/dev/sdb1       200G  120G   70G  64% /data'],
      hints: ['df -h', '-h(human-readable) 옵션을 붙이면 용량을 KB 대신 G/M 단위로 보기 좋게 보여줍니다.'],
      commandsTaught: [{ cmd: 'df -h', desc: '디스크 파티션별 사용 용량을 보기 좋은 단위로 확인' }],
      concept: '"디스크가 꽉 찼다"는 배포 실패, 로그 기록 실패 등 온갖 장애의 원인이 됩니다. df -h로 어느 파티션이 꽉 찼는지(Use% 98%처럼) 가장 먼저 확인하는 게 장애 대응의 기본입니다.',
      check: (s) => s.cmdName === 'df' && s.args.includes('-h') && !s.error,
    },
    {
      id: 'du-sh', title: '56화. 용량 많이 먹는 폴더 찾기', difficulty: 'medium',
      desc: '팀장: "/var/log 밑에 뭐가 이렇게 용량을 많이 먹는지 폴더별로 확인해봐."',
      fs: {},
      duOutput: ['2.1G\t/var/log/app', '8.4G\t/var/log/nginx', '512M\t/var/log/mysql', '11G\ttotal'],
      hints: ['du -sh /var/log/*', '-s(폴더 전체 합계) -h(보기 좋은 단위) 조합으로, 어느 하위 폴더가 용량을 많이 쓰는지 한눈에 볼 수 있어요.'],
      commandsTaught: [{ cmd: 'du -sh 경로', desc: '폴더별 총 사용 용량을 보기 좋은 단위로 확인' }],
      concept: 'df가 "파티션 전체가 얼마나 찼는지"를 보여준다면, du는 "어느 폴더가 범인인지" 찾을 때 씁니다. 로그 파일이 로테이션 안 되고 계속 쌓여서 디스크를 채우는 게 실무에서 정말 흔한 사고 원인이에요.',
      check: (s) => s.cmdName === 'du' && (s.args.includes('-sh') || s.args.includes('-h')) && !s.error,
    },
    {
      id: 'free-m', title: '57화. 최종 미션: 메모리 부족 진단', difficulty: 'hard',
      desc: '팀장: "서버가 갑자기 느려졌다는 신고가 들어왔어. 메모리 부족인지 확인하고, 메모리를 많이 먹는 프로세스가 있다면 찾아서 대응까지 해봐."',
      fs: {},
      processes: [{ pid: 9001, name: 'nginx', cpu: 0.5, mem: 1.0 }, { pid: 9002, name: 'memory-leak-app', cpu: 12.0, mem: 82.5 }, { pid: 9003, name: 'mysqld', cpu: 2.0, mem: 8.0 }],
      memOutput: ['              total        used        free      shared  buff/cache   available', 'Mem:           8192        7850         120          40         222         180', 'Swap:          2048        1900         148'],
      hints: ['free -m 로 먼저 메모리 상태를 확인하세요.', '그다음 ps aux 로 메모리를 많이 쓰는 프로세스를 찾고, kill로 종료해보세요 (예: memory-leak-app, pid 9002).'],
      commandsTaught: [{ cmd: 'free -m → ps aux → kill', desc: '메모리 부족 진단부터 원인 프로세스 종료까지 실전 대응 흐름' }],
      concept: '메모리 부족(free의 available이 거의 0)은 서버 전체를 느리게 만드는 대표적인 원인입니다. free로 "메모리가 부족하다"를 확인했다면, 그다음은 ps aux로 "누가 메모리를 많이 먹고 있는지" 찾아서 조치하는 게 실전 순서예요.',
      check: (s) => {
        const usedFreeM = s.ctx.history.some((h) => h.trim() === 'free -m' || h.trim().startsWith('free -m '));
        const killed = !(s.ctx.processes || []).some((p) => p.pid === 9002);
        return usedFreeM && killed;
      },
    },
  ];

  /* ============================================================
   * 게임 상태 / 저장
   * ========================================================== */
  const STORAGE_KEY = 'linuxQuestProgress_v1';
  const XP_PER_MISSION = 100;
  const XP_PER_LEVEL = 300;

  const DIFFICULTY_META = {
    easy: { label: '초급', stars: '★☆☆', className: 'diff-easy' },
    medium: { label: '중급', stars: '★★☆', className: 'diff-medium' },
    hard: { label: '고급', stars: '★★★', className: 'diff-hard' },
  };

  const game = {
    ctx: null,
    currentIndex: 0,
    completed: new Set(),
    xp: 0,
    hintIndex: 0,
    historyPointer: 0,
  };

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function saveProgress() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      currentIndex: game.currentIndex,
      completed: Array.from(game.completed),
      xp: game.xp,
    }));
  }
  function isUnlocked(i) {
    return i === 0 || game.completed.has(MISSIONS[i - 1].id);
  }

  /* ============================================================
   * DOM 참조
   * ========================================================== */
  const el = {
    levelNum: document.getElementById('levelNum'),
    xpFill: document.getElementById('xpFill'),
    xpText: document.getElementById('xpText'),
    missionList: document.getElementById('missionList'),
    missionTitle: document.getElementById('missionTitle'),
    missionDesc: document.getElementById('missionDesc'),
    hintBtn: document.getElementById('hintBtn'),
    hintText: document.getElementById('hintText'),
    conceptBtn: document.getElementById('conceptBtn'),
    conceptText: document.getElementById('conceptText'),
    resetMissionBtn: document.getElementById('resetMissionBtn'),
    terminalOutput: document.getElementById('terminalOutput'),
    terminalInput: document.getElementById('terminalInput'),
    terminalWindow: document.getElementById('terminalWindow'),
    promptLabel: document.getElementById('promptLabel'),
    cheatSheetBtn: document.getElementById('cheatSheetBtn'),
    cheatSheetModal: document.getElementById('cheatSheetModal'),
    cheatSheetList: document.getElementById('cheatSheetList'),
    closeCheatSheet: document.getElementById('closeCheatSheet'),
  };

  function promptString() {
    return `user@linux-game:${displayPath(game.ctx.cwd)}$`;
  }

  function updatePromptLabel() {
    el.promptLabel.textContent = promptString();
  }

  function appendLine(text, className) {
    const div = document.createElement('div');
    div.className = 'line ' + className;
    div.textContent = text;
    el.terminalOutput.appendChild(div);
  }

  function appendPromptLine(raw) {
    const div = document.createElement('div');
    div.className = 'line prompt-line';
    const echoSpan = document.createElement('span');
    echoSpan.className = 'prompt-echo';
    echoSpan.textContent = 'user@linux-game:';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'path-echo';
    pathSpan.textContent = displayPath(game.ctx.cwd);
    const dollarSpan = document.createElement('span');
    dollarSpan.className = 'prompt-echo';
    dollarSpan.textContent = '$ ';
    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'cmd-text';
    cmdSpan.textContent = raw;
    div.appendChild(echoSpan);
    div.appendChild(pathSpan);
    div.appendChild(dollarSpan);
    div.appendChild(cmdSpan);
    el.terminalOutput.appendChild(div);
  }

  function scrollTerminalToBottom() {
    el.terminalOutput.scrollTop = el.terminalOutput.scrollHeight;
  }

  function spawnConfetti() {
    const emojis = ['🎉', '✨', '🐧', '⭐'];
    for (let i = 0; i < 14; i++) {
      const span = document.createElement('span');
      span.className = 'confetti';
      span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      span.style.left = Math.random() * 100 + 'vw';
      span.style.animationDuration = 1.6 + Math.random() * 1.2 + 's';
      document.body.appendChild(span);
      setTimeout(() => span.remove(), 3000);
    }
  }

  function appendSuccessBanner(mission) {
    const wrap = document.createElement('div');
    wrap.className = 'success-banner';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '✅ 미션 성공! ' + mission.title;
    const xp = document.createElement('div');
    xp.className = 'xp';
    xp.textContent = `+${XP_PER_MISSION} XP 획득`;
    wrap.appendChild(title);
    wrap.appendChild(xp);

    const nextIndex = game.currentIndex + 1;
    if (nextIndex < MISSIONS.length) {
      const btn = document.createElement('button');
      btn.textContent = '다음 미션 ▶';
      btn.addEventListener('click', () => loadMission(nextIndex));
      wrap.appendChild(btn);
    } else {
      const done = document.createElement('div');
      done.className = 'title';
      done.style.marginTop = '6px';
      done.textContent = '🏆 모든 미션 클리어! 당신은 이제 리눅스 명령어를 다루는 SI 개발자입니다.';
      wrap.appendChild(done);
    }
    el.terminalOutput.appendChild(wrap);
    spawnConfetti();
  }

  function renderHeader() {
    const level = Math.floor(game.xp / XP_PER_LEVEL) + 1;
    const xpIntoLevel = game.xp % XP_PER_LEVEL;
    el.levelNum.textContent = level;
    el.xpFill.style.width = (xpIntoLevel / XP_PER_LEVEL) * 100 + '%';
    el.xpText.textContent = `${xpIntoLevel} / ${XP_PER_LEVEL} XP (총 ${game.xp} XP)`;
  }

  function renderSidebar() {
    el.missionList.innerHTML = '';
    MISSIONS.forEach((m, i) => {
      const li = document.createElement('li');
      const unlocked = isUnlocked(i);
      const done = game.completed.has(m.id);
      li.className = 'mission-item' + (unlocked ? '' : ' locked') + (done ? ' done' : '') + (i === game.currentIndex ? ' current' : '');
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = done ? '✅' : unlocked ? '▶' : '🔒';
      const label = document.createElement('span');
      label.className = 'mission-label';
      label.textContent = m.title;
      const diff = DIFFICULTY_META[m.difficulty];
      const diffBadge = document.createElement('span');
      diffBadge.className = 'diff-badge ' + diff.className;
      diffBadge.textContent = diff.stars;
      diffBadge.title = diff.label;
      li.appendChild(icon);
      li.appendChild(label);
      li.appendChild(diffBadge);
      if (unlocked) {
        li.addEventListener('click', () => loadMission(i));
      }
      el.missionList.appendChild(li);
    });
  }

  function renderMissionBrief(mission) {
    const diff = DIFFICULTY_META[mission.difficulty];
    el.missionTitle.innerHTML = '';
    const titleText = document.createElement('span');
    titleText.textContent = mission.title;
    const diffTag = document.createElement('span');
    diffTag.className = 'diff-tag ' + diff.className;
    diffTag.textContent = `${diff.stars} ${diff.label}`;
    el.missionTitle.appendChild(titleText);
    el.missionTitle.appendChild(diffTag);
    el.missionDesc.textContent = mission.desc;
    el.hintText.textContent = '';
    el.hintText.classList.add('hidden');
    game.hintIndex = 0;
    el.conceptText.textContent = '';
    el.conceptText.classList.add('hidden');
    el.conceptBtn.classList.toggle('hidden', !mission.concept);
  }

  function clearTerminalDOM() {
    el.terminalOutput.innerHTML = '';
  }

  function loadMission(index) {
    const mission = MISSIONS[index];
    game.currentIndex = index;
    game.ctx = {
      root: buildRoot(cloneTree(mission.fs || {})),
      cwd: HOME_PATH.slice(),
      history: [],
      processes: mission.processes ? cloneTree(mission.processes) : [],
      services: mission.services ? cloneTree(mission.services) : [],
      jobs: [],
      diskOutput: mission.diskOutput || null,
      duOutput: mission.duOutput || null,
      memOutput: mission.memOutput || null,
    };
    game.historyPointer = 0;
    clearTerminalDOM();
    appendLine(`=== ${mission.title} ===`, 'system-line');
    appendLine('명령어를 입력하고 Enter를 눌러 미션을 해결하세요. (도움이 필요하면 "help" 입력)', 'system-line');
    renderMissionBrief(mission);
    updatePromptLabel();
    renderSidebar();
    saveProgress();
    el.terminalInput.focus();
  }

  function completeMission() {
    const mission = MISSIONS[game.currentIndex];
    if (game.completed.has(mission.id)) return;
    game.completed.add(mission.id);
    game.xp += XP_PER_MISSION;
    saveProgress();
    appendSuccessBanner(mission);
    renderHeader();
    renderSidebar();
  }

  function handleSubmit() {
    const raw = el.terminalInput.value;
    if (raw.trim() === '') return;
    appendPromptLine(raw);
    const chainResult = executeChain(raw, game.ctx);
    el.terminalInput.value = '';
    game.historyPointer = game.ctx.history.length;
    if (!chainResult) { updatePromptLabel(); return; }

    let allOutput = [];
    let hadError = false;
    let lastSeg = null;
    chainResult.segments.forEach((seg) => {
      if (seg.clear) clearTerminalDOM();
      if (seg.error) { appendLine(seg.error, 'error-line'); hadError = true; }
      else seg.output.forEach((line) => appendLine(line, 'output-line'));
      allOutput = allOutput.concat(seg.output || []);
      lastSeg = seg;
    });
    if (chainResult.backgroundJob) {
      appendLine(`[${chainResult.backgroundJob.id}] ${chainResult.backgroundJob.pid}`, 'system-line');
    }
    updatePromptLabel();

    const mission = MISSIONS[game.currentIndex];
    if (!game.completed.has(mission.id)) {
      const state = {
        ctx: game.ctx,
        cmdName: lastSeg ? lastSeg.cmdName : null,
        args: lastSeg ? lastSeg.args : [],
        raw: chainResult.raw,
        output: lastSeg ? lastSeg.output : [],
        error: lastSeg ? lastSeg.error : null,
        allOutput,
        hadError,
        cmdNames: chainResult.segments.map((s) => s.cmdName),
      };
      let passed = false;
      try { passed = mission.check(state); } catch (e) { passed = false; }
      if (passed) completeMission();
    }
    scrollTerminalToBottom();
  }

  function renderCheatSheet() {
    el.cheatSheetList.innerHTML = '';
    const seen = new Set();
    MISSIONS.forEach((m, i) => {
      if (!isUnlocked(i) && !game.completed.has(m.id)) return;
      m.commandsTaught.forEach((c) => {
        if (seen.has(c.cmd)) return;
        seen.add(c.cmd);
        const item = document.createElement('div');
        item.className = 'cheat-item';
        const cmd = document.createElement('div');
        cmd.className = 'cmd';
        cmd.textContent = c.cmd;
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = c.desc;
        item.appendChild(cmd);
        item.appendChild(desc);
        el.cheatSheetList.appendChild(item);
      });
    });
    if (seen.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'desc';
      empty.textContent = '아직 배운 명령어가 없습니다. 첫 미션을 클리어해보세요!';
      el.cheatSheetList.appendChild(empty);
    }
  }

  /* ============================================================
   * 이벤트 바인딩
   * ========================================================== */
  el.terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (game.ctx.history.length === 0) return;
      game.historyPointer = Math.max(0, game.historyPointer - 1);
      el.terminalInput.value = game.ctx.history[game.historyPointer] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (game.ctx.history.length === 0) return;
      game.historyPointer = Math.min(game.ctx.history.length, game.historyPointer + 1);
      el.terminalInput.value = game.ctx.history[game.historyPointer] || '';
    }
  });

  el.terminalWindow.addEventListener('click', () => el.terminalInput.focus());

  el.hintBtn.addEventListener('click', () => {
    const mission = MISSIONS[game.currentIndex];
    el.hintText.textContent = '💡 ' + mission.hints[game.hintIndex];
    el.hintText.classList.remove('hidden');
    game.hintIndex = (game.hintIndex + 1) % mission.hints.length;
  });

  el.conceptBtn.addEventListener('click', () => {
    const mission = MISSIONS[game.currentIndex];
    if (!mission.concept) return;
    el.conceptText.textContent = '📚 ' + mission.concept;
    el.conceptText.classList.toggle('hidden');
  });

  el.resetMissionBtn.addEventListener('click', () => loadMission(game.currentIndex));

  el.cheatSheetBtn.addEventListener('click', () => {
    renderCheatSheet();
    el.cheatSheetModal.classList.remove('hidden');
  });
  el.closeCheatSheet.addEventListener('click', () => el.cheatSheetModal.classList.add('hidden'));
  el.cheatSheetModal.addEventListener('click', (e) => {
    if (e.target === el.cheatSheetModal) el.cheatSheetModal.classList.add('hidden');
  });

  /* ============================================================
   * 초기화
   * ========================================================== */
  function init() {
    const saved = loadProgress();
    if (saved) {
      game.completed = new Set(saved.completed || []);
      game.xp = saved.xp || 0;
      game.currentIndex = Math.min(saved.currentIndex || 0, MISSIONS.length - 1);
    }
    loadMission(game.currentIndex);
    renderHeader();
  }

  init();
})();
