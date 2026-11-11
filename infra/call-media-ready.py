"""Fix late device enumeration in the pinned official Element Call widget.

Readable source: src/state/localMediaControls.ts, followMuteState().
It must publish when the default enabled switch becomes true after enumeration,
as well as when the user explicitly unmutes. No capture starts while muted.
shortcut: exact pinned bundle patch; remove when upstream handles late devices.
"""
from pathlib import Path

bundle = Path('/call/assets/index-qyqr4qTO.js')
before = 'e.onEnd(()=>t.unsetHandler()),n.pipe(e.bind()).subscribe'
after = '''e.onEnd(()=>t.unsetHandler()),t.enabled$.pipe(e.bind()).subscribe(enabled=>{
  o=enabled;
  if(enabled&&n.value===void 0)void(async()=>{
    await r.ready?.();
    if(t.enabled$.value&&n.value===void 0)await r.publish();
  })().catch(error=>a.error(`Failed to publish the ${i}`,error));
}),n.pipe(e.bind()).subscribe'''
source = bundle.read_text()
assert source.count(before) == 1, 'Element Call bundle changed; review the microphone readiness fix'
bundle.write_text(source.replace(before, after))
# nginx gzip_static would otherwise serve the unpatched original.
bundle.with_suffix('.js.gz').unlink(missing_ok=True)
