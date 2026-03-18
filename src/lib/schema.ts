import { z } from 'zod';

// AI(OpenClaw)가 반환하는 JSON 배열의 단일 항목에 대한 Zod 검증 스키마.
// AI 응답에서 필드가 누락되거나 다른 케이싱으로 반환될 경우 default 값으로 대체한다.
// passthrough()를 사용해 스키마에 없는 추가 필드(예: OsVersion)도 허용한다.
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
