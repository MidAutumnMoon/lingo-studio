import type { CodeToTokensOptions, GrammarState, HighlighterCore, HighlighterGeneric, ThemedToken } from 'shiki/core'

export type ShikiStreamTokenizerOptions = CodeToTokensOptions<string, string> & {
  highlighter: HighlighterCore | HighlighterGeneric<any, any>
}

export interface ShikiStreamTokenizerEnqueueResult {
  /**
   * 要撤回的行数
   */
  recall: number
  /**
   * 稳定行
   */
  stable: ThemedToken[][]
  /**
   * 不稳定行
   */
  unstable: ThemedToken[][]
}

/**
 * 修改自 shiki-stream 的 tokenizer（上游现为 @shikijs/stream）。
 *
 * 保留自有实现的原因（2026-10 基于 @shikijs/stream@4.5.0 的评估）：
 * - 本实现按行输出（ThemedToken[][]）、recall 按行计；上游输出带 '\n' 哨兵 token 的
 *   扁平数组、recall 按 token 计，消费者（worker 协议、CodeViewer 行渲染）需适配层。
 * - 上游 enqueue 逐行调用 codeToTokens，且无界累积 tokensStable：整块重入时其
 *   spread 在约 1 万行处栈溢出，内存也随流式内容无限增长。
 * 上游若提供批量 enqueue 或渲染层改用扁平 token 模型，可重新评估合并。
 */
export class ShikiStreamTokenizer {
  public readonly options: ShikiStreamTokenizerOptions

  public linesUnstable: ThemedToken[][] = []

  public lastUnstableCodeChunk: string = ''
  public lastStableGrammarState: GrammarState | undefined

  constructor(options: ShikiStreamTokenizerOptions) {
    this.options = options
  }

  /**
   * 使用 tokenizer 处理一个代码片段。
   */
  async enqueue(chunk: string): Promise<ShikiStreamTokenizerEnqueueResult> {
    const subTrunks = splitToSubTrunks(this.lastUnstableCodeChunk + chunk)

    const stable: ThemedToken[][] = []
    const unstable: ThemedToken[][] = []
    const recall = this.linesUnstable.length

    subTrunks.forEach((subTrunck, i) => {
      const isLastChunk = i === subTrunks.length - 1

      const result = this.options.highlighter.codeToTokens(subTrunck, {
        ...this.options,
        grammarState: this.lastStableGrammarState
      })

      if (!isLastChunk) {
        this.lastStableGrammarState = result.grammarState

        result.tokens.forEach((tokenLine) => {
          stable.push(tokenLine)
        })
      } else {
        unstable.push(result.tokens[0])
        this.lastUnstableCodeChunk = subTrunck
      }
    })

    this.linesUnstable = unstable

    return {
      recall,
      stable,
      unstable
    }
  }

  close(): { stable: ThemedToken[][] } {
    const stable = this.linesUnstable
    this.linesUnstable = []
    this.lastUnstableCodeChunk = ''
    this.lastStableGrammarState = undefined
    return {
      stable
    }
  }

  clear(): void {
    this.linesUnstable = []
    this.lastUnstableCodeChunk = ''
    this.lastStableGrammarState = undefined
  }
}

/**
 * 将代码字符串 chunk 按行分割为至多两个 subtrunks
 * @param chunk 代码字符串
 * @returns subtrunks 数组
 */
export function splitToSubTrunks(chunk: string) {
  const lastNewlineIndex = chunk.lastIndexOf('\n')
  if (lastNewlineIndex === -1) {
    return [chunk]
  }
  return [chunk.substring(0, lastNewlineIndex), chunk.substring(lastNewlineIndex + 1)]
}
