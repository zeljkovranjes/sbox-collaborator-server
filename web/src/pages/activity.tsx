import { useState } from 'preact/hooks';
import { api, type Activity, type Digest, type Project } from '../api';
import { Empty, Eyebrow, Icon, Loading, useAction, useLoad } from '../lib';
import { SummaryText } from '../summary';
import { Timeline } from './home';

export function ActivityPage({ project }: { project: Project }) {
  const [min, setMin] = useState(0);
  const feed = useLoad(() => api.tool<Activity[]>('activity_recent', { project: project.id, limit: 200, minImportance: min }), [project.id, min]);
  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Activity</h1>
          <p>Everything the team and its agents did, newest first.</p>
        </div>
        <div class="seg">
          {[
            [0, 'Everything'],
            [1, 'Normal'],
            [2, 'Notable'],
            [3, 'Critical'],
          ].map(([value, label]) => (
            <button key={value} class={min === value ? 'on' : ''} onClick={() => setMin(value as number)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div class="split">
        <div class="panel">{feed.data ? <Timeline items={feed.data} /> : <Loading />}</div>
        <Digests project={project} />
      </div>
    </>
  );
}

function Digests({ project }: { project: Project }) {
  const digests = useLoad(() => api.get<Digest[]>(`/api/digests?project=${encodeURIComponent(project.id)}`), [project.id]);
  const [live, setLive] = useState<Digest | null>(null);
  const act = useAction();
  const shown = live ?? digests.data?.[0] ?? null;
  return (
    <div class="panel">
      <Eyebrow
        icon="summarize"
        title={live ? 'Last 7 days (live)' : 'Weekly digest'}
        aside={
          <button class="linkish tiny" onClick={async () => setLive((await act(() => api.tool<Digest>('team_digest', { project: project.id, days: 7 }))) ?? null)}>
            generate now
          </button>
        }
      />
      <div class="panel-body">
        {!digests.data ? (
          <Loading />
        ) : shown ? (
          <>
            <SummaryText text={shown.summary} />
            {!live && digests.data.length > 1 && (
              <div class="tiny faint" style="margin-top:10px">
                <Icon name="history" style="font-size:13px;vertical-align:-2px" /> {digests.data.length - 1} earlier digest(s)
              </div>
            )}
          </>
        ) : (
          <Empty icon="summarize" text="The first digest is written on the next digest day (Monday 09:00 by default)." />
        )}
      </div>
    </div>
  );
}
