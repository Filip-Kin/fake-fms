import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the control server runs on :3010; proxy the control API + state websocket to it.
const CONTROL = process.env.CONTROL_URL ?? "http://localhost:3010";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			"/control": CONTROL,
			"/games": CONTROL,
			"/ws": { target: CONTROL, ws: true },
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
