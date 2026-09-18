import { redirect } from 'next/navigation';

/** The Plan section opens on the cash forecast: for a pre-launch business, runway is the question. */
export default function PlanPage() {
  redirect('/plan/forecast');
}
