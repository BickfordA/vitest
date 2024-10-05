import { existsSync, promises as fs } from 'node:fs'

import { createBirpc } from 'birpc'
import { parse, stringify } from 'flatted'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import type { ViteDevServer } from 'vite'
import type { File, TaskResultPack } from '@vitest/runner'
import { API_PATH } from '../constants'
import type { Vitest } from '../node/core'
import type { Awaitable, ModuleGraphData, UserConsoleLog } from '../types/general'
import type { Reporter } from '../node/types/reporter'
import { getModuleGraph, isPrimitive, noop, stringifyReplace } from '../utils'
import { parseErrorStacktrace } from '../utils/source-map'
import type { SerializedTestSpecification } from '../runtime/types/utils'
import type {
  TransformResultWithSource,
  WebSocketEvents,
  WebSocketHandlers,
  WebSocketRPC,
} from './types'

export function setup(ctx: Vitest, _server?: ViteDevServer) {
  const wss = new WebSocketServer({ noServer: true })

  const clients = new Map<WebSocket, WebSocketRPC>()

  const server = _server || ctx.server

  server.httpServer?.on('upgrade', (request, socket, head) => {
    if (!request.url) {
      return
    }

    const { pathname } = new URL(request.url, 'http://localhost')
    if (pathname !== API_PATH) {
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
      setupClient(ws)
    })
  })

  function setupClient(ws: WebSocket) {
    const rpc = createBirpc<WebSocketEvents, WebSocketHandlers>(
      {
        async onTaskUpdate(packs) {
          ctx.state.updateTasks(packs)
          await ctx.report('onTaskUpdate', packs)
        },
        getFiles() {
          return ctx.state.getFiles()
        },
        getPaths() {
          return ctx.state.getPaths()
        },
        async readTestFile(id) {
          if (!ctx.state.filesMap.has(id) || !existsSync(id)) {
            return null
          }
          return fs.readFile(id, 'utf-8')
        },
        async saveTestFile(id, content) {
          if (!ctx.state.filesMap.has(id) || !existsSync(id)) {
            throw new Error(
              `Test file "${id}" was not registered, so it cannot be updated using the API.`,
            )
          }
          return fs.writeFile(id, content, 'utf-8')
        },
        async rerun(files, resetTestNamePattern) {
          await ctx.rerunFiles(files, undefined, resetTestNamePattern)
        },
        async rerunTestOrSuite(id, filename) {
          await ctx.rerunTestOrSuite(id, filename)
        },
        getConfig() {
          return ctx.getCoreWorkspaceProject().getSerializableConfig()
        },
        async getTransformResult(projectName: string, id, browser = false) {
          const project = ctx.getProjectByName(projectName)
          const result: TransformResultWithSource | null | undefined = browser
            ? await project.browser!.vite.transformRequest(id)
            : await project.vitenode.transformRequest(id)
          if (result) {
            try {
              result.source = result.source || (await fs.readFile(id, 'utf-8'))
            }
            catch {}
            return result
          }
        },
        async getModuleGraph(project, id, browser): Promise<ModuleGraphData> {
          return getModuleGraph(ctx, project, id, browser)
        },
        updateSnapshot(file?: File) {
          if (!file) {
            return ctx.updateSnapshot()
          }
          return ctx.updateSnapshot([file.filepath])
        },
        getUnhandledErrors() {
          return ctx.state.getUnhandledErrors()
        },
        async getTestFiles() {
          const spec = await ctx.globTestSpecs()
          return spec.map(spec => [
            {
              name: spec.project.config.name,
              root: spec.project.config.root,
            },
            spec.moduleId,
            { pool: spec.pool },
          ])
        },
      },
      {
        post: msg => ws.send(msg),
        on: fn => ws.on('message', fn),
        eventNames: [
          'onUserConsoleLog',
          'onFinished',
          'onFinishedReportCoverage',
          'onCollected',
          'onTaskUpdate',
        ],
        serialize: (data: any) => stringify(data, stringifyReplace),
        deserialize: parse,
        onTimeoutError(functionName) {
          throw new Error(`[vitest-api]: Timeout calling "${functionName}"`)
        },
      },
    )

    clients.set(ws, rpc)

    ws.on('close', () => {
      clients.delete(ws)
    })
  }

  ctx.reporters.push(new WebSocketReporter(ctx, wss, clients))
}

export class WebSocketReporter implements Reporter {
  constructor(
    public ctx: Vitest,
    public wss: WebSocketServer,
    public clients: Map<WebSocket, WebSocketRPC>,
  ) {}

  onCollected(files?: File[]) {
    if (this.clients.size === 0) {
      return
    }
    this.clients.forEach((client) => {
      client.onCollected?.(files)?.catch?.(noop)
    })
  }

  onSpecsCollected(specs?: SerializedTestSpecification[] | undefined): Awaitable<void> {
    if (this.clients.size === 0) {
      return
    }
    this.clients.forEach((client) => {
      client.onSpecsCollected?.(specs)?.catch?.(noop)
    })
  }

  async onTaskUpdate(packs: TaskResultPack[]) {
    if (this.clients.size === 0) {
      return
    }

    packs.forEach(([taskId, result]) => {
      const project = this.ctx.getProjectByTaskId(taskId)
      const task = this.ctx.state.idMap.get(taskId)
      const isBrowser = task && task.file.pool === 'browser'

      result?.errors?.forEach((error) => {
        if (isPrimitive(error)) {
          return
        }

        const stacks = isBrowser
          ? project.browser?.parseErrorStacktrace(error)
          : parseErrorStacktrace(error)
        error.stacks = stacks
      })
    })

    this.clients.forEach((client) => {
      client.onTaskUpdate?.(packs)?.catch?.(noop)
    })
  }

  onFinished(files: File[], errors: unknown[]) {
    this.clients.forEach((client) => {
      client.onFinished?.(files, errors)?.catch?.(noop)
    })
  }

  onFinishedReportCoverage() {
    this.clients.forEach((client) => {
      client.onFinishedReportCoverage?.()?.catch?.(noop)
    })
  }

  onUserConsoleLog(log: UserConsoleLog) {
    this.clients.forEach((client) => {
      client.onUserConsoleLog?.(log)?.catch?.(noop)
    })
  }
}
