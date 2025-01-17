import { renderToReadableStream } from "react-dom/server";
import { createCompilerHandler } from "ultra/lib/react/compiler.ts";
import { createRenderHandler } from "ultra/lib/react/renderer.ts";
import UltraServer from "ultra/lib/react/server.js";
import { readImportMap } from "ultra/lib/utils/import-map.ts";
import { createStaticHandler } from "ultra/lib/static/handler.ts";
import { composeHandlers } from "ultra/lib/handler.ts";
import { refresh } from "https://deno.land/x/refresh@1.0.0/mod.ts";
import { serve } from "https://deno.land/std@0.176.0/http/server.ts";
import { compile } from "https://deno.land/x/mesozoic@v1.3.10/lib/compiler.ts";
import { join } from "https://deno.land/std@0.203.0/url/mod.ts";
import { StaticRouter } from "react-router-dom/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/trpc/router.ts";
import { TRPCServerProvider } from "@/trpc/server.tsx";

import App from "./App.tsx";
import { HelmetProvider } from "react-helmet-async";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/react-query/query-client.ts";
import { StrictMode } from "react";

const root = Deno.cwd();

const importMap = Deno.env.get("ULTRA_MODE") === "development"
  ? await readImportMap("./importMap.dev.json")
  : await readImportMap("./importMap.json");

importMap.imports["ultra/"] = "/ultra/";
importMap.imports["@/"] = "/packages/";
importMap.imports["zod"] = "/_x/zod@v3.21.4/mod.ts";
importMap.imports["https://deno.land/x/"] = "/_x/";
// ts_brand@0.0.1/mod.ts


// const handleRequest = async (request: Request): Promise<Response> => {
//   const { pathname } = new URL(request.url);
//   const filePath = pathname.replace(prefix, "./");
//   const fileUrl = join(root, filePath);

//   const source = await Deno.readTextFile(fileUrl);
//   const result = await compile(fileUrl.toString(), source, {
//     jsxImportSource: "react",
//     development: true,
//   });

//   return new Response(result, {
//     headers: {
//       "Content-Type": "application/javascript",
//     },
//   });
// };

const renderer = createRenderHandler({
  root,
  render(request) {
    return renderToReadableStream(
      // <UltraServer request={request} importMap={importMap}>
      //   <TRPCServerProvider>
      //     <StaticRouter location={new URL(request.url).pathname}>
      //       <Shell />
      //     </StaticRouter>
      //   </TRPCServerProvider>
      // </UltraServer>,

      <UltraServer request={request} importMap={importMap}>
        <StrictMode>
          <HelmetProvider>
            <QueryClientProvider client={queryClient}>
              <TRPCServerProvider>
                <StaticRouter location={new URL(request.url).pathname}>
                  <App />
                </StaticRouter>
              </TRPCServerProvider>
            </QueryClientProvider>
          </HelmetProvider>
        </StrictMode>
      </UltraServer>,
      {
        bootstrapModules: [
          import.meta.resolve("./client.tsx"),
        ],
      },
    );
  },
});

const compiler = createCompilerHandler({
  root,
});

const staticHandler = createStaticHandler({
  pathToRoot: import.meta.resolve("./public"),
});

const executeHandlers = composeHandlers(
  renderer,
  compiler,
  {
    supportsRequest: (request) => {
      return request.url.includes("/ultra/");
    },
    handleRequest: async (request) => {
      const { pathname } = new URL(request.url);
      return new Response(
        (await Deno.open(root + "/.." + pathname)).readable,
        {
          headers: {
            "Content-Type": "application/javascript",
          },
        },
      );
    },
  },
  {
    supportsRequest: (request) => {
      return request.url.includes("/packages/");
    },
    handleRequest: async (request) => {
      const { pathname } = new URL(request.url);
      const realPathName = pathname.split("/packages/")[1];

      const fileUrl = root + "/packages/" + realPathName;
      const source = await Deno.readTextFile(fileUrl);
      const result = await compile(fileUrl.toString(), source, {
        jsxImportSource: "react",
        development: true,
        minify: false,
      });

      return new Response(
        result,
        {
          headers: {
            "Content-Type": "application/javascript",
          },
        },
      );
    },
  },
  {
    supportsRequest: (request) => {
      return request.url.includes("/_x/");
    },
    handleRequest: async (request) => {
      const { pathname } = new URL(request.url);
      const realPathName = pathname.split("/_x/")[1];
      const fullPathName = `https://deno.land/x/${realPathName}`
      const content = await fetch(fullPathName);
      const result = await compile(fullPathName, await content.text(), {
        jsxImportSource: "react",
        development: true,
        minify: false,
      });

      return new Response(
        result,
        {
          headers: {
            "Content-Type": "application/javascript",
          },
        },
      );
    },
  },
  {
    supportsRequest: (request) => {
      const { pathname } = new URL(request.url);
      return pathname.startsWith("/api/trpc");
    },
    handleRequest: (request) =>
      fetchRequestHandler({
        endpoint: "/api/trpc",
        req: request,
        router: appRouter,
        createContext: () => ({}),
      }),
  },
  staticHandler,
);

const middleware = refresh();

serve((request) => {
  const refresh = middleware(request);
  if (refresh) return refresh;

  const response = executeHandlers(request);
  if (response) return response;

  return new Response("Not Found", { status: 404 });
});
