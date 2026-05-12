import { z } from "zod";

export const FilterSchema = z.enum(["all", "active", "completed"]);

export const CreateTodoSchema = z
  .object({
    title: z.string().min(1),
  })
  .strict();

export const PatchTodoSchema = z
  .object({
    title: z.string().min(1).optional(),
    completed: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.completed !== undefined, {
    message: "must include title or completed",
  });

export const ToggleAllSchema = z
  .object({
    completed: z.boolean(),
  })
  .strict();
