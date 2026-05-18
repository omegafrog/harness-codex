import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  FileText,
  GitBranch,
  Loader2,
  MessageSquareText,
  Play,
  RotateCw,
  Send,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

const reviewTabs = [
  { id: 'requirements', label: 'Requirements', icon: FileText },
  { id: 'useCases', label: 'Use Cases', icon: GitBranch },
] as const

type ReviewTab = (typeof reviewTabs)[number]['id']

type Clarification = {
  questions: Array<{ question: string; recommended: string }>
  answer: string
}

type HarvestState = {
  initial_prompt: string
  status: string
  active_stage: ReviewTab
  requirements_markdown: string
  use_cases_markdown: string
  clarifications: Clarification[]
  current_question: { question: string; recommended: string } | null
  current_questions: Array<{ question: string; recommended: string }>
  requirements_gate_passed: boolean
  use_cases_ready: boolean
  workflow: {
    name: string
    steps: Array<{
      id: string
      agent_id: string | null
      skill_id: string | null
      needs: string[]
      outputs: string[]
    }>
  }
}

function emptyState(): HarvestState {
  return {
    initial_prompt: '',
    status: 'idle',
    active_stage: 'requirements',
    requirements_markdown: '',
    use_cases_markdown: '',
    clarifications: [],
    current_question: null,
    current_questions: [],
    requirements_gate_passed: false,
    use_cases_ready: false,
    workflow: { name: 'harness-full-workflow', steps: [] },
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed: ${response.status}`)
  }
  return data as T
}

function normalizePrompt(prompt: string) {
  return prompt.trim() || 'No prompt provided.'
}

function App() {
  const [initialPrompt, setInitialPrompt] = useState('')
  const [state, setState] = useState<HarvestState>(emptyState)
  const [hasRunRequirements, setHasRunRequirements] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [activeTab, setActiveTab] = useState<ReviewTab>('requirements')
  const [answerText, setAnswerText] = useState('')
  const [error, setError] = useState('')
  const [apiConnected, setApiConnected] = useState(false)

  useEffect(() => {
    let alive = true
    api<HarvestState>('/api/harvest')
      .then((result) => {
        if (!alive) {
          return
        }
        setState(result)
        setInitialPrompt(result.initial_prompt)
        setHasRunRequirements(Boolean(result.initial_prompt))
        setActiveTab(result.active_stage)
        setApiConnected(true)
      })
      .catch((exc: Error) => {
        if (alive) {
          setApiConnected(false)
          setError(exc.message)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const runRequirements = async () => {
    if (!initialPrompt.trim() || isRunning) {
      return
    }

    setIsRunning(true)
    setError('')
    try {
      const result = await api<HarvestState>('/api/requirements/start', {
        prompt: initialPrompt,
      })
      setState(result)
      setApiConnected(true)
      setHasRunRequirements(true)
      setActiveTab('requirements')
    } catch (exc) {
      setApiConnected(false)
      setError((exc as Error).message)
    } finally {
      setIsRunning(false)
    }
  }

  const submitAnswer = async () => {
    const answer = answerText.trim()
    if (!answer || state.requirements_gate_passed || isRunning) {
      return
    }

    setIsRunning(true)
    setError('')
    try {
      const result = await api<HarvestState>('/api/requirements/answer', { answer })
      setState(result)
      setApiConnected(true)
      setAnswerText('')
      setActiveTab('requirements')
    } catch (exc) {
      setApiConnected(false)
      setError((exc as Error).message)
    } finally {
      setIsRunning(false)
    }
  }

  const startUseCases = async () => {
    if (!state.requirements_gate_passed || isRunning) {
      return
    }

    setIsRunning(true)
    setError('')
    try {
      const result = await api<HarvestState>('/api/use-cases/start')
      setState(result)
      setApiConnected(true)
      setActiveTab('useCases')
    } catch (exc) {
      setApiConnected(false)
      setError((exc as Error).message)
    } finally {
      setIsRunning(false)
    }
  }

  const resetToPrompt = () => {
    setHasRunRequirements(false)
    setActiveTab('requirements')
  }

  if (!hasRunRequirements) {
    return (
      <main className="min-h-svh bg-background text-foreground">
        <section className="mx-auto flex min-h-svh w-full max-w-5xl flex-col justify-center px-5 py-8">
          <div className="max-w-3xl">
            <Badge variant="outline" className="mb-5 gap-2 rounded-md">
              <FileText className="size-3.5" />
              {apiConnected ? 'Runtime API connected' : 'Runtime API disconnected'}
            </Badge>
            <h1 className="text-4xl font-semibold tracking-normal text-balance sm:text-5xl">
              Start requirements harvest.
            </h1>
          </div>

          <Card className="mt-8 max-w-3xl rounded-lg">
            <CardHeader>
              <CardTitle>Initial Prompt</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={initialPrompt}
                onChange={(event) => setInitialPrompt(event.target.value)}
                placeholder="Build a workflow that separates requirements and use-case generation..."
                className="min-h-40 resize-none"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="font-medium">API</div>
                <p className="mt-1 text-muted-foreground">
                  {apiConnected
                    ? 'Connected through Vite proxy: /api -> 127.0.0.1:8765'
                    : 'Waiting for /api/harvest response'}
                </p>
              </div>
              <div className="flex justify-end">
                <Button
                  onClick={runRequirements}
                  disabled={!initialPrompt.trim() || isRunning}
                  className="gap-2"
                >
                  {isRunning ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  Run requirements
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    )
  }

  const active = reviewTabs.find((tab) => tab.id === activeTab) ?? reviewTabs[0]
  const ActiveIcon = active.icon
  const markdown =
    activeTab === 'requirements'
      ? state.requirements_markdown
      : state.use_cases_markdown

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex min-h-svh w-full max-w-7xl flex-col px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={resetToPrompt}
              aria-label="Back"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-normal">
                  Requirements Review
                </h1>
                <Badge
                  variant={state.requirements_gate_passed ? 'secondary' : 'outline'}
                  className="rounded-md"
                >
                  {state.requirements_gate_passed ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <CircleDashed className="size-3" />
                  )}
                  {state.requirements_gate_passed
                    ? 'requirements passed'
                    : 'grill-me running'}
                </Badge>
                <Badge
                  variant={apiConnected ? 'secondary' : 'destructive'}
                  className="rounded-md"
                >
                  {apiConnected ? 'API connected' : 'API disconnected'}
                </Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {normalizePrompt(state.initial_prompt)}
              </p>
            </div>
          </div>

          <div className="flex rounded-md border bg-muted/40 p-1">
            {reviewTabs.map((tab) => {
              const Icon = tab.icon
              const disabled = tab.id === 'useCases' && !state.use_cases_ready
              return (
                <Button
                  key={tab.id}
                  type="button"
                  variant={activeTab === tab.id ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setActiveTab(tab.id)}
                  disabled={disabled}
                  className="gap-2"
                >
                  <Icon className="size-4" />
                  {tab.label}
                </Button>
              )
            })}
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_390px]">
          <Card className="min-h-0 overflow-hidden rounded-lg">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <ActiveIcon className="size-4" />
                {active.label}
              </CardTitle>
              <Badge variant="outline" className="rounded-md">
                {isRunning ? 'running runtime' : state.status}
              </Badge>
            </CardHeader>
            <CardContent className="max-h-[calc(100svh-13rem)] overflow-auto pt-6">
              <article className="prose prose-neutral max-w-none dark:prose-invert prose-headings:tracking-normal prose-table:text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {markdown || 'Runtime output not created yet.'}
                </ReactMarkdown>
              </article>
            </CardContent>
          </Card>

          <aside className="flex min-h-0 flex-col gap-4">
            {activeTab === 'requirements' ? (
              <>
                <Card className="rounded-lg">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <RotateCw className="size-4" />
                      Requirements Gate
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="rounded-md border p-3">
                      <div className="text-sm font-medium">
                        {state.requirements_gate_passed
                          ? 'Grill-Me complete'
                          : `Questions ${state.clarifications.length + 1}`}
                      </div>
                      {state.requirements_gate_passed ? (
                        <p className="mt-1 text-sm leading-6">
                          Requirements can proceed to use-case generation.
                        </p>
                      ) : (
                        <ol className="mt-2 space-y-3">
                          {state.current_questions.map((item, index) => (
                            <li key={`${item.question}-${index}`}>
                              <p className="text-sm leading-6">
                                {index + 1}. {item.question}
                              </p>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                Recommended answer: {item.recommended}
                              </p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </CardContent>
                </Card>

                {!state.requirements_gate_passed ? (
                  <Card className="rounded-lg">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <MessageSquareText className="size-4" />
                        Grill-Me Answer
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Textarea
                        value={answerText}
                        onChange={(event) => setAnswerText(event.target.value)}
                        disabled={isRunning}
                        placeholder="Answer all Grill-Me questions in this batch..."
                        className="min-h-32 resize-none"
                      />
                      <Button
                        onClick={submitAnswer}
                        disabled={!answerText.trim() || isRunning}
                        className="w-full gap-2"
                      >
                        {isRunning ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Send className="size-4" />
                        )}
                        Submit and rerun requirements
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="rounded-lg">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <GitBranch className="size-4" />
                        Next Stage
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm leading-6 text-muted-foreground">
                        Use-case generation reads the passed requirements
                        artifact. Grill-Me does not run here.
                      </p>
                      <Button
                        onClick={startUseCases}
                        disabled={isRunning}
                        className="w-full gap-2"
                      >
                        {isRunning ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <GitBranch className="size-4" />
                        )}
                        Proceed to use cases
                      </Button>
                    </CardContent>
                  </Card>
                )}

                <Card className="min-h-0 flex-1 rounded-lg">
                  <CardHeader>
                    <CardTitle className="text-base">Grill-Me History</CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 overflow-auto">
                    {state.clarifications.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No Grill-Me answers yet.
                      </p>
                    ) : (
                      <ol className="space-y-3">
                        {state.clarifications.map((item, index) => (
                          <li key={`gm-${index}`} className="text-sm">
                            <div className="font-medium">GM-{index + 1}</div>
                            <ol className="mt-1 space-y-1">
                              {(item.questions ?? []).map((question, questionIndex) => (
                                <li
                                  key={`${question.question}-${questionIndex}`}
                                  className="leading-6"
                                >
                                  {questionIndex + 1}. {question.question}
                                </li>
                              ))}
                            </ol>
                            <p className="mt-1 leading-6 text-muted-foreground">
                              {item.answer}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card className="rounded-lg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileText className="size-4" />
                    Source Requirements
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm leading-6">
                  <p>
                    Use cases are generated only from the passed requirements
                    result. Grill-Me does not run in the use-case stage.
                  </p>
                  <div className="rounded-md border p-3">
                    <div className="font-medium">Runtime</div>
                    <p className="text-muted-foreground">{state.workflow.name}</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="font-medium">API</div>
                    <p className="text-muted-foreground">
                      /api/use-cases/start
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="font-medium">Input</div>
                    <p className="text-muted-foreground">
                      docs/design/요구사항.md
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </aside>
        </section>
      </div>
    </main>
  )
}

export default App
