import type { AnyGameModule } from "./game-module";
import { game2026 } from "./game2026";

const MODULES: Record<string, AnyGameModule> = {
	[game2026.id]: game2026 as AnyGameModule,
};

export const DEFAULT_GAME_ID = game2026.id;

export function getGameModule(id: string): AnyGameModule {
	return MODULES[id] ?? (game2026 as AnyGameModule);
}

export function listGameModules(): AnyGameModule[] {
	return Object.values(MODULES);
}
