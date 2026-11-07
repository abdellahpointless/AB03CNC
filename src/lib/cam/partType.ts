/*
 * The shop's part families, which decide where precision matters (camAi.partType.* on the page):
 *   topPlate      the contour on the RAFI (white) face, where a part is inserted: straight walls,
 *                 exact radii; engravings on the top
 *   sealCage      hollow ALU/MS parts with a long thin wall: precise inner and outer walls
 *   pinPlate      a plate the pins are pressed into (contact pin plate, test pin plate…): its 1, 2
 *                 and 3 mm holes; a pin itself ("guidance pin") is another part
 *   contourInsert its contour is where the shop's part goes in: high quality
 *   subPlate      other plates: produced normally
 *   other         anything else: produced normally
 */

export const PART_TYPES = ['topPlate', 'sealCage', 'pinPlate', 'contourInsert', 'subPlate', 'other'] as const;
export type PartType = (typeof PART_TYPES)[number];

/** The family from the PDF's title ("Top plate 100201637205"); null when there is no title. */
export function partTypeOf(title: string | null | undefined): PartType | null {
  if (!title?.trim()) return null;
  const t = title.toLowerCase();
  if (/seal\s*cage|dichtungsk/.test(t)) return 'sealCage';
  if (/contour\s*insert|kontur\s*einsatz|konture?insatz/.test(t)) return 'contourInsert';
  if (/top\s*plate|oberplatte/.test(t)) return 'topPlate';
  if (/pin\s*plate|stift\s*platte|pinplatte/.test(t)) return 'pinPlate';
  if (/plate|platte/.test(t)) return 'subPlate';
  return 'other';
}
