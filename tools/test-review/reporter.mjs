// node --test reporter: one JSON line per test/suite result, with its location.
export default async function* reporter(source) {
  for await (const ev of source) {
    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const d = ev.data;
      yield JSON.stringify({ ok: ev.type === 'test:pass', kind: d.details?.type || 'test', name: d.name,
        nesting: d.nesting, file: d.file, line: d.line, column: d.column }) + '\n';
    }
  }
}
