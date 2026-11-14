import { EventList } from "../../events-ui";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <EventList selected={(await params).id} />;
}
