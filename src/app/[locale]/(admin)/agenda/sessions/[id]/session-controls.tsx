'use client';

import type { SessionStatus, SessionPersonRole } from '@/lib/validation/agenda';
import type { Database } from '@/types/database';
import StatusControl from './status-control';
import SessionEditForm from './session-edit-form';
import SpeakerAssignment from './speaker-assignment';
import RescheduleAndReassign from './reschedule-and-reassign';
import TagWeighting from './tag-weighting';

type Session = Database['public']['Tables']['sessions']['Row'];

type SessionPersonRow = {
  id: string;
  person_id: string;
  role: SessionPersonRole;
  display_order: number;
  is_primary: boolean;
  people: { id: string; full_name_ar: string; full_name_en: string } | null;
};

type SessionTagRow = {
  id: string;
  tag_id: string;
  weight: number;
  tags: { id: string; name_ar: string; name_en: string } | null;
};

type RefOption = { id: string; [key: string]: unknown };

export default function SessionControls({
  session,
  sessionPeople,
  sessionTags,
  validNextStatuses,
  days,
  tracks,
  sessionTypes,
  rooms,
  people,
  tags,
}: {
  session: Session;
  sessionPeople: SessionPersonRow[];
  sessionTags: SessionTagRow[];
  validNextStatuses: SessionStatus[];
  days: RefOption[];
  tracks: RefOption[];
  sessionTypes: RefOption[];
  rooms: RefOption[];
  people: RefOption[];
  tags: RefOption[];
}) {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <StatusControl
        sessionId={session.id}
        currentStatus={session.status}
        validNextStatuses={validNextStatuses}
      />

      <SessionEditForm
        session={session}
        days={days}
        tracks={tracks}
        sessionTypes={sessionTypes}
        rooms={rooms}
      />

      <SpeakerAssignment
        sessionId={session.id}
        sessionPeople={sessionPeople}
        people={people}
      />

      <RescheduleAndReassign
        session={session}
        sessionPeople={sessionPeople}
        people={people}
        rooms={rooms}
      />

      <TagWeighting
        sessionId={session.id}
        sessionTags={sessionTags}
        tags={tags}
      />
    </div>
  );
}
