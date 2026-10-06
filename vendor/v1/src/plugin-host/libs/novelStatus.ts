/** @libs/novelStatus — LNReader's NovelStatus constants (LNReader/lnreader-plugins, MIT). */
export const NovelStatus = {
  Unknown: 'Unknown',
  Ongoing: 'Ongoing',
  Completed: 'Completed',
  Licensed: 'Licensed',
  PublishingFinished: 'Publishing Finished',
  Cancelled: 'Cancelled',
  OnHiatus: 'On Hiatus',
  STUB: 'STUB',
  Inactive: 'Inactive',
} as const;
export type NovelStatus = (typeof NovelStatus)[keyof typeof NovelStatus];
