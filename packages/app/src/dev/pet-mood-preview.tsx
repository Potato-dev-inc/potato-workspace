import type { FC } from 'react';
import { Pet } from '../components/pet/Pet';
import { newPet, petReduce, petView } from '../components/pet/petModel';
import { petMoodLook } from '../components/pet/petMood';
import type { BodyView } from '../lib/companion';

// Desktop Potato wearing the default companion's saved mood: the real Pet, petReduce and petView, with the same four moods the
// sidebar row shows. No window is ever opened.

const MOODS: Array<{ title: string; body: Pick<BodyView, 'mood' | 'intensity' | 'sleeping'> | null; less?: boolean }> = [
  { title: 'No mood (Labs off)', body: null },
  { title: 'Sleepy', body: { mood: 'sleepy', intensity: 1, sleeping: false } },
  { title: 'Asleep', body: { mood: 'sleepy', intensity: 3, sleeping: true } },
  { title: 'Hungry', body: { mood: 'hungry', intensity: 2, sleeping: false } },
  { title: 'Full of beans', body: { mood: 'genki', intensity: 3, sleeping: false } },
  { title: 'Grumpy, but here', body: { mood: 'tsundere', intensity: 1, sleeping: false } },
  { title: 'Full of beans, Less motion', body: { mood: 'genki', intensity: 3, sleeping: false }, less: true },
];

const noop = () => undefined;

export const PetMoodPreview: FC = () => (
  <div className="pet-desktop" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
    <style>{`
      .pet-desktop{position:fixed;inset:0;z-index:99999;display:grid;gap:10px;padding:10px;background:linear-gradient(135deg,#2b3340,#1b2029);align-content:start}
      .pet-cell{position:relative;height:290px;border:1px dashed rgba(255,255,255,.16);border-radius:10px;overflow:hidden}
      .pet-cell .pet-root{position:absolute}
      .pet-cell-title{position:absolute;left:10px;top:8px;font:12px system-ui,sans-serif;color:rgba(255,255,255,.7)}
    `}</style>
    {MOODS.map((cell) => {
      const look = petMoodLook(cell.body);
      const model = petReduce(newPet(0), { type: 'mood', mood: look }, 0);
      const view = petView(model, 1_000, cell.less === true);
      return (
        <div className="pet-cell" key={cell.title}>
          <Pet view={view} size="medium" quietChoice={false} companionName="Mochi" moodKey={look?.key} onOpenAgent={noop} onLater={noop} onDismiss={noop} onDragStart={noop} onHide={noop} onSize={noop} onQuiet={noop} onOff={noop} />
          <span className="pet-cell-title">{cell.title}</span>
        </div>
      );
    })}
  </div>
);
