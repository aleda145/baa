import type { GameEventKind, GameItem, GameState, Lane } from "../types";

type FinishDefinition = {
  kind: "wheat";
  lane: Lane;
};

export type ItemCollisionResult =
  | {
      kind: "none";
    }
  | {
      kind: "restart";
      event: GameEventKind;
    };

export type CourseEndResult =
  | {
      kind: "loop";
    }
  | {
      kind: "finish";
      event: GameEventKind;
    };

export type LevelDefinition = {
  id: number;
  name: string;
  shortName: string;
  description: string;
  finish: FinishDefinition | null;
  createItems: () => GameItem[];
  resolveItemCollision: (
    item: GameItem,
    state: GameState,
  ) => ItemCollisionResult;
  resolveCourseEnd: (state: GameState) => CourseEndResult;
};

function makeWolf(id: string, lane: Lane, distance: number): GameItem {
  return {
    id,
    kind: "wolf",
    lane,
    distance,
    collectedOrHit: false,
    missed: false,
  };
}

function ignoreItemCollision(): ItemCollisionResult {
  return { kind: "none" };
}

function restartOnWolves(item: GameItem): ItemCollisionResult {
  if (item.kind === "wolf") {
    return {
      kind: "restart",
      event: "wolf-hit",
    };
  }

  return { kind: "none" };
}

function wheatFinish(finish: FinishDefinition | null) {
  return (state: GameState): CourseEndResult => {
    if (finish !== null && state.sheep.lane === finish.lane) {
      return {
        kind: "finish",
        event: "finish",
      };
    }

    return { kind: "loop" };
  };
}

const topLaneWheat: FinishDefinition = {
  kind: "wheat",
  lane: 1,
};

export const levels: LevelDefinition[] = [
  {
    id: 0,
    name: "Onboarding",
    shortName: "Onboarding",
    description: "Find your baas",
    finish: null,
    createItems: () => [],
    resolveItemCollision: ignoreItemCollision,
    resolveCourseEnd: wheatFinish(null),
  },
  {
    id: 1,
    name: "Wheat",
    shortName: "Wheat",
    description: "Reach the wheat",
    finish: topLaneWheat,
    createItems: () => [],
    resolveItemCollision: ignoreItemCollision,
    resolveCourseEnd: wheatFinish(topLaneWheat),
  },
  {
    id: 2,
    name: "Wolves",
    shortName: "Wolves",
    description: "Dodge the wolves",
    finish: topLaneWheat,
    createItems: () => [
      makeWolf("wolf-top", 1, 920),
      makeWolf("wolf-bottom", -1, 1700),
      makeWolf("wolf-middle", 0, 2440),
    ],
    resolveItemCollision: restartOnWolves,
    resolveCourseEnd: wheatFinish(topLaneWheat),
  },
];

export function getLevel(id: number): LevelDefinition {
  return levels.find((level) => level.id === id) ?? levels[0];
}

export function getNextLevel(currentLevelId: number): LevelDefinition | null {
  return levels.find((level) => level.id > currentLevelId) ?? null;
}
