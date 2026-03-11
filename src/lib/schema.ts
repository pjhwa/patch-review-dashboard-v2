import { z } from 'zod';

export const ReviewItemSchema = z.object({
    IssueID: z.string().default("Unknown"),
    Component: z.string().default("Unknown"),
    Version: z.string().default("Unknown"),
    Vendor: z.string().default("Unknown"),
    Date: z.string().optional().default("Unknown"),
    Criticality: z.string().default("Unknown"),
    Description: z.string().default("Unknown"),
    KoreanDescription: z.string().default("Unknown"),
    Decision: z.string().optional().default("Done"),
    Reason: z.string().optional().default(""),
    // Fallbacks for LLM casing issues (will map dynamically if needed, but strict Zod forces exact match or throws)
}).passthrough(); // passthrough allows missing case-insensitive ones to exist if mapped later

export const ReviewSchema = z.array(ReviewItemSchema);
