import { ArrowRight, Bot, Check, FileText, Send, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

const stages = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'useCases', label: 'Use Cases' },
  { id: 'eventStorming', label: 'Event Storming' },
] as const

type StageId = (typeof stages)[number]['id']

type Answer = {
  question: string
  response: string
}

const questions = [
  'Who is the primary actor, and what result should they observe first?',
  'Which failure case must the first implementation handle explicitly?',
  'What runtime or delivery constraint should guide implementation planning?',
]

const buildRequirementsMarkdown = (prompt: string, answers: Answer[]) => {
  const answerLines =
    answers.length === 0
      ? '- No clarification answers yet.'
      : answers
          .map(
            (item, index) =>
              `- Q${index + 1}: ${item.question}\n  - Answer: ${item.response}`,
          )
          .join('\n')

  return `# Requirements

## Product Intent

- Initial prompt: ${prompt}
- Runtime scope: harvest through event-storming artifacts.
- Delivery target: agent-assisted document updates before implementation planning.

## Functional Requirements

| ID | Requirement | Status |
|---|---|---|
| FR-001 | The system shall turn an initial prompt into a requirements document. | draft |
| FR-002 | The system shall ask focused clarification questions when requirements are incomplete. | draft |
| FR-003 | The system shall update the visible markdown after each answer. | draft |

## Non-Functional Requirements

| Area | Requirement | Status |
|---|---|---|
| Traceability | Each answer should affect requirements, use cases, or event-storming notes. | draft |
| Usability | The current document must remain readable while answering the agent. | draft |
| Scope Control | The UI stops at event storming and does not expose planning or execution. | fixed |

## Clarification Log

${answerLines}
`
}

const buildUseCasesMarkdown = (answers: Answer[]) => {
  const actor = answers[0]?.response || 'confirmation needed'
  const exception = answers[1]?.response || 'confirmation needed'
  const runtime = answers[2]?.response || 'confirmation needed'

  return `# Use Cases

## UC-001. User Converts Prompt Into Requirements

| Item | Value |
|---|---|
| Primary actor | ${actor} |
| Goal | Convert the initial prompt into approved harvest artifacts. |
| Runtime constraint | ${runtime} |

### Basic Flow

1. User enters an initial product prompt.
2. System opens the requirements workspace.
3. Agent asks the next concrete clarification question.
4. User answers at the bottom input.
5. System updates the markdown artifact preview.

### Exception Flow

- ${exception}
`
}

const buildEventStormingMarkdown = (answers: Answer[]) => {
  const actor = answers[0]?.response || 'confirmation needed'
  const exception = answers[1]?.response || 'confirmation needed'
  const runtime = answers[2]?.response || 'confirmation needed'

  return `# Event Storming

## UC-001 Slice

| Type | Name | Source | Status |
|---|---|---|---|
| Command | Submit initial prompt | User input | draft |
| Command | Answer clarification question | Requirements page | draft |
| Event | Requirements draft updated | Markdown preview | draft |
| Event | Use-case slice drafted | Harvest workspace | draft |
| Policy | If implementation scope is unclear, ask one focused question | Agent workflow | draft |

## Open Decisions

- Primary actor: ${actor}
- Critical exception path: ${exception}
- Runtime or delivery constraint: ${runtime}
`
}

function App() {
  const [prompt, setPrompt] = useState('')
  const [hasStarted, setHasStarted] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [answers, setAnswers] = useState<Answer[]>([])
  const [activeStage, setActiveStage] = useState<StageId>('requirements')

  const currentQuestion = questions[Math.min(answers.length, questions.length - 1)]
  const markdownByStage = useMemo(
    () => ({
      requirements: buildRequirementsMarkdown(prompt.trim(), answers),
      useCases: buildUseCasesMarkdown(answers),
      eventStorming: buildEventStormingMarkdown(answers),
    }),
    [answers, prompt],
  )

  const submitPrompt = () => {
    if (!prompt.trim()) {
      return
    }
    setHasStarted(true)
  }

  const submitAnswer = () => {
    if (!answerText.trim()) {
      return
    }
    setAnswers((current) => [
      ...current,
      {
        question: currentQuestion,
        response: answerText.trim(),
      },
    ])
    setAnswerText('')
  }

  if (!hasStarted) {
    return (
      <main className="min-h-svh bg-background text-foreground">
        <section className="mx-auto flex min-h-svh w-full max-w-5xl flex-col justify-center px-6 py-10">
          <div className="max-w-3xl">
            <Badge variant="outline" className="mb-6 gap-2">
              <Sparkles className="size-3.5" />
              Harvest Runtime UI
            </Badge>
            <h1 className="text-4xl font-semibold tracking-normal text-balance sm:text-5xl">
              Start harvest from one implementation prompt.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
              Requirements, use cases, and event-storming draft stay in one focused
              workspace.
            </p>
          </div>

          <Card className="mt-10 max-w-3xl">
            <CardHeader>
              <CardTitle>Initial Prompt</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Build a runtime orchestration UI for harvest through event storming..."
                className="min-h-36 resize-none"
              />
              <div className="flex justify-end">
                <Button onClick={submitPrompt} className="gap-2">
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex min-h-svh w-full max-w-7xl flex-col px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Harness Harvest</p>
            <h1 className="text-2xl font-semibold tracking-normal">Requirements</h1>
          </div>
          <div className="flex rounded-md border bg-muted/40 p-1">
            {stages.map((stage) => (
              <Button
                key={stage.id}
                type="button"
                variant={activeStage === stage.id ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setActiveStage(stage.id)}
              >
                {stage.label}
              </Button>
            ))}
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="min-h-0">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="size-4" />
                {stages.find((stage) => stage.id === activeStage)?.label}
              </CardTitle>
              <Badge variant="secondary" className="gap-1">
                <Check className="size-3" />
                Live draft
              </Badge>
            </CardHeader>
            <CardContent>
              <article className="prose prose-neutral max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {markdownByStage[activeStage]}
                </ReactMarkdown>
              </article>
            </CardContent>
          </Card>

          <aside className="flex min-h-0 flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="size-4" />
                  Agent Question
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">
                  {currentQuestion}
                </p>
              </CardContent>
            </Card>

            <Card className="mt-auto">
              <CardContent className="space-y-3 pt-6">
                <Textarea
                  value={answerText}
                  onChange={(event) => setAnswerText(event.target.value)}
                  placeholder="Type answer for the agent..."
                  className="min-h-28 resize-none"
                />
                <Button onClick={submitAnswer} className="w-full gap-2">
                  Send Answer
                  <Send className="size-4" />
                </Button>
              </CardContent>
            </Card>
          </aside>
        </section>
      </div>
    </main>
  )
}

export default App
