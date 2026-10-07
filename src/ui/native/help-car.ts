/**
 * Help & Tips › Listening: v2's answers for listening in the car (docs/car.md). v1's say "let your PC
 * narrate, then import into BookPlayer", which v2 no longer needs. v1's Help screen reads the shared HELP
 * array when it opens, so main.ts replacing the two items at startup is enough (vendor/v1 stays unmodified).
 */
import type { HelpItem, HelpTopic } from '@v1/ui/lib/help-data.ts';

export const CAR_HELP: readonly HelpItem[] = [
  {
    id: 'car',
    q: 'Can I listen to a novel in the car?',
    a: 'Yes. Tap the headphones in the reader (or More › Listen) and the novel plays through CarPlay or Bluetooth like any audio app. CarPlay’s Now Playing screen shows the chapter, the novel and its cover; the steering-wheel buttons and Siri (“Hey Siri, pause”, “resume”, “next”) work too. Each chapter continues into the next by itself.',
  },
  {
    id: 'car-prepare',
    q: 'How do I make sure it never stops to load in the car?',
    a: 'Open the novel and tap Prepare for the drive. Kokoro reads the next 1, 3, 5 or 10 chapters into audio on your iPhone, right away or while it charges or is on Wi-Fi. Prepared chapters play without the internet and are deleted after you listen to them. More › Voices › In the car shows how much space they take.',
  },
  {
    id: 'car-buttons',
    q: 'What do the buttons in the car do?',
    a: 'Play/pause, plus either previous/next chapter or back/forward 15 seconds: choose in More › Voices › In the car › Car buttons. Headphone and steering-wheel buttons follow the same choice. “Previous” goes back to the start of the chapter, or to the chapter before if you just started it. Dragging the time bar jumps within the chapter.',
  },
  {
    id: 'car-calls',
    q: 'What happens during calls and navigation directions?',
    a: 'Narration pauses for calls and spoken directions and continues by itself afterwards. Disconnecting from the car or your headphones pauses it until you press play again.',
  },
  {
    id: 'carplay-app',
    q: 'Why is there no TachiNovel icon on the CarPlay screen?',
    a: 'A CarPlay app needs a permission that Apple grants to audio apps from the App Store. Until then, TachiNovel shows up in CarPlay’s Now Playing screen, which has all the controls you need while driving.',
  },
];

/** Replace v1's PC-narrator car answers with v2's (idempotent). */
export function installCarHelp(topics: readonly HelpTopic[]): void {
  const listening = topics.find((t) => t.title === 'Listening');
  if (!listening || listening.items.some((i) => i.id === 'car-prepare')) return;
  listening.items = [...CAR_HELP, ...listening.items.filter((i) => i.id !== 'car' && i.id !== 'car-next')];
}
