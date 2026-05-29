export type LevelDefinition = {
  id: number;
  name: string;
  shortName: string;
  description: string;
}

export const levels: LevelDefinition[] = [
  {
    id: 0,
    name: "Warmup",
    shortName: "Setup",
    description: "Find your baas",
  },
  {
    id: 1,
    name: "Wheat Run",
    shortName: "Wheat",
    description: "Reach the wheat",
  },
];

export function getLevel(id: number): LevelDefinition {
  return levels.find((level) => level.id === id) ?? levels[0];
}
