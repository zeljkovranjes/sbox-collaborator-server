import { useState } from 'preact/hooks';
import { api, type Activity, type Project } from '../api';
import { Loading, useLoad } from '../lib';
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
      <div class="panel" style="max-width:980px">{feed.data ? <Timeline items={feed.data} /> : <Loading />}</div>
    </>
  );
}
