import { z } from "zod";

export const citationSchema = z.object({
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  page: z.number().int().positive().nullable(),
});

export const solutionSchema = z.object({
  grounding: z.enum(["retrieved", "general_knowledge"]),
  warning: z.string().min(1).nullable(),
  subject: z.enum(["mathematics", "physics", "chemistry", "biology"]),
  topic: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  givens: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
  formulas: z.array(z.object({
    latex: z.string().min(1),
    description: z.string().min(1),
  })),
  steps: z.array(z.object({
    title: z.string().min(1),
    explanation: z.string().min(1),
    latex: z.string().min(1).nullable(),
  })).min(1),
  finalAnswer: z.string().min(1),
  shortcutTip: z.string().min(1).nullable(),
  citations: z.array(citationSchema),
  followupQuestionId: z.string().uuid().nullable(),
});

export type StructuredSolution = z.infer<typeof solutionSchema>;
