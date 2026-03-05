import { getDictionary, Locale } from "@/lib/i18n";
import { cookies } from "next/headers";
import { CategoryArchiveClient } from "./ClientPage";

export default async function CategoryArchivePage({ params }: { params: Promise<{ categoryId: string }> }) {
    const { categoryId } = await params;

    // Setup i18n safely on the Server
    const cookieStore = await cookies();
    const locale = (cookieStore.get('NEXT_LOCALE')?.value || 'ko') as Locale;
    const dict = getDictionary(locale);

    return <CategoryArchiveClient categoryId={categoryId} dict={dict} />;
}
