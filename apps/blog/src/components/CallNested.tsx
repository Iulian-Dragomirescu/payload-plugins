"use client";

import { callNested } from "../actions/callNested";

/**
 * A button on the dashboard that runs a nested read on the server.
 *
 * `beforeDashboard` renders this through Payload's `RenderServerComponent`,
 * which passes only `clientProps` to a client component. So it takes no props:
 * the `payload` instance and the request state stay on the server, which is
 * also where the output goes.
 *
 * Watch the terminal running `next dev`, not the browser console.
 */
export function CallNested() {
  return (
    <button className="btn btn--style-primary" onClick={() => void callNested()} type="button">
      call nested
    </button>
  );
}
