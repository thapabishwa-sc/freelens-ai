import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import pluginExternal from "vite-plugin-external";
import sassDts from "vite-plugin-sass-dts";

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, "src/main/index.ts"),
        formats: ["cjs"],
      },
      rollupOptions: {
        output: {
          exports: "named",
          preserveModules: true,
          preserveModulesRoot: "src/main",
        },
      },
      sourcemap: true,
    },
    plugins: [
      react({
        babel: {
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-05" }],
          ],
        },
      }),
      externalizeDepsPlugin({
        include: ["@freelensapp/extensions", "mobx"],
      }),
      pluginExternal({
        externals: {
          "@freelensapp/extensions": "global.LensExtensions",
          mobx: "global.Mobx",
        },
      }),
    ],
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, "src/renderer/index.tsx"),
        formats: ["cjs"],
      },
      outDir: "out/renderer",
      rollupOptions: {
        output: {
          exports: "named",
          preserveModules: true,
          preserveModulesRoot: "src/renderer",
        },
      },
      sourcemap: true,
    },
    css: {
      modules: {
        localsConvention: "camelCaseOnly",
      },
    },
    plugins: [
      sassDts({
        enabledMode: ["development", "production"],
      }),
      react({
        babel: {
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-05" }],
          ],
        },
      }),
      externalizeDepsPlugin({
        include: [
          "@freelensapp/extensions",
          "electron",
          "mobx",
          "mobx-react",
          "react",
          "react-dom",
          "react-router-dom",
        ],
        exclude: ["@anthropic-ai/sdk", "ansi_up", "dompurify", "reactflow"],
      }),
      pluginExternal({
        externals: {
          "@freelensapp/extensions": "global.LensExtensions",
          mobx: "global.Mobx",
          "mobx-react": "global.MobxReact",
          react: "global.React",
          "react-dom": "global.ReactDOM",
          "react-router-dom": "global.ReactRouterDom",
          "react/jsx-runtime": "global.ReactJsxRuntime",
        },
      }),
    ],
  },
});
