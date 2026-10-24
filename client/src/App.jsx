import { useEffect, useState } from "react";

import ShapeGrid from "./ShapeGrid.jsx";

const EMPTY_EVENT = {
  is_event_poster: true,
  title: "",
  date: "",
  start_time: "",
  end_time: "",
  location: "",
  description: "",
  confidence: "low",
  notes: "",
};

const TIMEZONE = "Africa/Accra";

function dateToCompact(value) {
  return value.replaceAll("-", "");
}

function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function timeToCompact(dateValue, timeValue) {
  return `${dateToCompact(dateValue)}T${timeValue.replace(":", "")}00`;
}

function oneHourLater(dateValue, timeValue) {
  const date = new Date(`${dateValue}T${timeValue}:00Z`);
  date.setUTCHours(date.getUTCHours() + 1);
  return {
    date: date.toISOString().slice(0, 10),
    time: `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`,
  };
}

function calendarRange(event) {
  if (!event.start_time) {
    return `${dateToCompact(event.date)}/${dateToCompact(addDays(event.date, 1))}`;
  }

  const end = event.end_time
    ? { date: event.date, time: event.end_time }
    : oneHourLater(event.date, event.start_time);

  return `${timeToCompact(event.date, event.start_time)}/${timeToCompact(end.date, end.time)}`;
}

function calendarUrl(event) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: calendarRange(event),
    details: event.description || "Added with Campus Poster Reader.",
    location: event.location || "",
    ctz: TIMEZONE,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function escapeIcs(value = "") {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function foldIcsLine(line) {
  const output = [];
  let current = "";
  let byteLength = 0;

  for (const character of line) {
    const characterBytes = new TextEncoder().encode(character).length;
    if (byteLength + characterBytes > 75) {
      output.push(current);
      current = ` ${character}`;
      byteLength = 1 + characterBytes;
    } else {
      current += character;
      byteLength += characterBytes;
    }
  }

  output.push(current);
  return output.join("\r\n");
}

function makeIcs(event) {
  const now = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Campus Poster Reader//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE",
    `TZID:${TIMEZONE}`,
    `X-LIC-LOCATION:${TIMEZONE}`,
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0000",
    "TZNAME:GMT",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@campus-poster-reader.local`,
    `DTSTAMP:${now}`,
  ];

  if (!event.start_time) {
    lines.push(
      `DTSTART;VALUE=DATE:${dateToCompact(event.date)}`,
      `DTEND;VALUE=DATE:${dateToCompact(addDays(event.date, 1))}`,
    );
  } else {
    const end = event.end_time
      ? { date: event.date, time: event.end_time }
      : oneHourLater(event.date, event.start_time);
    lines.push(
      `DTSTART;TZID=${TIMEZONE}:${timeToCompact(event.date, event.start_time)}`,
      `DTEND;TZID=${TIMEZONE}:${timeToCompact(end.date, end.time)}`,
    );
  }

  lines.push(
    `SUMMARY:${escapeIcs(event.title)}`,
    `DESCRIPTION:${escapeIcs(event.description || "Added with Campus Poster Reader.")}`,
    `LOCATION:${escapeIcs(event.location || "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  );

  return lines.map(foldIcsLine).join("\r\n");
}

function Field({ label, name, value, onChange, type = "text", multiline = false, valueClassName = "" }) {
  const commonClass = `form-control mt-2 px-3 py-2.5 text-base ${type === "date" || type === "time" ? "date-time-control" : ""} ${valueClassName}`;

  return (
    <label className="form-label block text-sm font-semibold text-muted">
      {label}
      {multiline ? (
        <textarea
          className={`${commonClass} min-h-24 resize-y`}
          name={name}
          value={value ?? ""}
          onChange={onChange}
          rows={3}
        />
      ) : (
        <input
          className={commonClass}
          name={name}
          type={type}
          value={value ?? ""}
          onChange={onChange}
        />
      )}
    </label>
  );
}

function App() {
  const [theme, setTheme] = useState(() => window.localStorage.getItem("campus-poster-reader-theme") || "light");
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    window.localStorage.setItem("campus-poster-reader-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return undefined;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function selectFile(nextFile) {
    setError("");
    setEvent(null);
    if (!nextFile) return;

    if (!nextFile.type.startsWith("image/")) {
      setFile(null);
      setError("Choose an image file, such as a JPG, PNG, or WebP.");
      return;
    }

    if (nextFile.size > 8 * 1024 * 1024) {
      setFile(null);
      setError("That image is larger than 8 MB. Choose a smaller image.");
      return;
    }

    setFile(nextFile);
  }

  async function readPoster() {
    if (!file) return;

    setLoading(true);
    setError("");
    setEvent(null);

    try {
      const formData = new FormData();
      formData.append("poster", file);
      const response = await fetch("/api/extract", { method: "POST", body: formData });
      // Read as text first: proxy/startup failures can return an empty body or
      // an HTML error page, neither of which response.json() can parse.
      const responseText = await response.text();
      let body = null;
      if (responseText.trim()) {
        try {
          body = JSON.parse(responseText);
        } catch {
          body = null;
        }
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        if (!response.ok) {
          throw new Error(`The poster reader server returned an unreadable response (HTTP ${response.status}). Check that the backend is running, then try again.`);
        }
        throw new Error("The poster reader server returned an empty response. Restart the backend and try again.");
      }

      if (!response.ok) throw new Error(body.error || "We couldn't read that poster. Please try again.");

      if (!body.event || typeof body.event !== "object") {
        throw new Error("The poster reader returned incomplete event details. Please try again.");
      }

      const extracted = body.event;
      setEvent({
        ...EMPTY_EVENT,
        ...extracted,
        title: extracted.title ?? "",
        date: extracted.date ?? "",
        start_time: extracted.start_time ?? "",
        end_time: extracted.end_time ?? "",
        location: extracted.location ?? "",
        description: extracted.description ?? "",
        notes: extracted.notes ?? "",
      });
    } catch (readError) {
      setError(readError.message);
    } finally {
      setLoading(false);
    }
  }

  function updateEvent(eventTarget) {
    const { name, value } = eventTarget;
    setEvent((previous) => ({ ...previous, [name]: value }));
  }

  function downloadIcs() {
    const blob = new Blob([makeIcs(event)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(event.title || "campus-event").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "campus-event"}.ics`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const isNotPoster = event && event.is_event_poster === false;
  const showNotes = event && (event.confidence !== "high" || Boolean(event.notes?.trim()));
  const canAddToCalendar = Boolean(event?.title?.trim() && event?.date);

  return (
    <div className="app-shell bg-canvas font-body text-ink" data-theme={theme}>
      <div className="app-background-grid" aria-hidden="true">
        <ShapeGrid
          shape="square"
          direction="diagonal"
          lineColor={theme === "dark" ? "#2b3e32" : "#b7d0be"}
          hoverColor={theme === "dark" ? "#69a982" : "#0F5132"}
          hoverFillColor={theme === "dark" ? "#69a982" : "#0F5132"}
          fillOpacity={0.45}
          cellSize={40}
          speed={0.5}
          tiltX={0}
          tiltY={0}
          rainbow={false}
          opacity={0.55}
          glow={0.08}
          clickCascade={false}
          backgroundColor={theme === "dark" ? "#171d19" : "#FAF6EE"}
        />
      </div>
      <header className="app-header">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="#top" className="flex items-center gap-3 text-ink no-underline" aria-label="Campus Poster Reader home">
            <span className="grid size-9 place-items-center bg-forest text-white">
              <CalendarIcon />
            </span>
            <span className="font-display text-base font-bold tracking-tight sm:text-lg">Campus Poster Reader</span>
          </a>
          <div className="flex items-center gap-2">
            <span className="hidden border-r border-line pr-4 text-xs font-semibold uppercase tracking-[0.12em] text-muted sm:inline-block">
              Hacktoberfest 2026
            </span>
            <button
              type="button"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              className="inline-flex min-h-10 items-center gap-2 border border-line bg-paper px-3 text-sm font-semibold text-ink transition hover:border-forest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              <span>{theme === "dark" ? "Dark mode" : "Light mode"}</span>
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-6xl px-4 pb-12 pt-10 sm:px-8 sm:pb-16 sm:pt-16">
        <section className="mb-9 max-w-4xl sm:mb-12">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-forest">A KNUST campus companion</p>
          <h1 className="font-display text-5xl font-extrabold leading-[0.98] tracking-[-0.045em] text-ink sm:text-7xl">
            Drop a poster.<br className="hidden sm:block" /> <span className="text-forest">Never miss</span> an event.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-7 text-muted sm:text-xl">
            Snap any notice on campus and we’ll put it in your calendar.
          </p>
        </section>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.5fr)_minmax(230px,0.65fr)] lg:gap-14">
        <section aria-labelledby="upload-heading">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-gold-ink">Step 01</p>
              <h2 id="upload-heading" className="mt-1 font-display text-2xl font-bold text-ink">Choose your poster</h2>
            </div>
            <p className="text-sm text-muted">JPG, PNG or another image · up to 8 MB</p>
          </div>

          <div
            className={`notice-slot grid overflow-hidden border-2 border-dashed transition-colors sm:grid-cols-[minmax(0,1fr)_210px] ${dragging ? "border-forest bg-paper" : "border-line bg-paper"}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              selectFile(event.dataTransfer.files?.[0]);
            }}
          >
            <div className="flex min-h-52 flex-col items-center justify-center px-5 py-8 text-center sm:min-h-60">
              <span className="grid size-12 place-items-center border border-line text-forest">
                <UploadIcon />
              </span>
              <p className="mt-4 font-display text-lg font-bold text-ink">Drop an event poster here</p>
              <p className="mt-1 text-sm text-muted">or choose an image from your device</p>
              <label htmlFor="poster-file" className="mt-5 inline-flex min-h-10 cursor-pointer items-center justify-center rounded-md bg-forest px-5 text-sm font-semibold text-white transition hover:bg-gold hover:text-ink">
                Choose image
              </label>
              <input
                id="poster-file"
                className="sr-only"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => selectFile(event.target.files?.[0])}
              />
            </div>

            {file && previewUrl ? (
              <div className="relative min-h-52 border-t border-line bg-canvas p-3 sm:min-h-60 sm:border-l sm:border-t-0">
                <img src={previewUrl} alt="Preview of the selected campus event poster" className="h-full max-h-64 w-full object-contain sm:absolute sm:inset-3 sm:h-[calc(100%-1.5rem)] sm:w-[calc(100%-1.5rem)]" />
                <span className="absolute bottom-5 left-5 max-w-[calc(100%-2.5rem)] truncate bg-paper px-2.5 py-1.5 text-xs font-semibold text-ink">{file.name}</span>
              </div>
            ) : (
              <div className="hidden min-h-60 place-items-center border-l border-line bg-canvas sm:grid">
                <div className="grid size-24 place-items-center border border-line text-muted">
                  <PosterIcon />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="mt-4 flex items-start gap-2 border border-warning-border bg-warning-background px-3.5 py-3 text-sm text-warning-foreground">
              <WarningIcon />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-4 flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
            <p className="max-w-md text-sm leading-5 text-muted">Your image is sent to Gemma 4 to read. We don’t save it on this app.</p>
            <button
              type="button"
              onClick={readPoster}
              disabled={!file || loading}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-forest px-5 text-sm font-semibold text-white transition-colors hover:bg-gold hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <span className="reading-pulse" role="status" aria-live="polite">Reading poster...</span> : <>Read poster <ArrowIcon /></>}
            </button>
          </div>
        </section>

        <aside className="border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" aria-label="How Campus Poster Reader works">
          <section>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-gold-ink">From flyer to calendar</p>
            <ol className="mt-5 divide-y divide-line">
              <li className="flex gap-4 py-4 first:pt-0"><span className="text-sm font-bold text-forest">01</span><div><p className="font-display font-bold text-ink">Choose a poster</p><p className="mt-1 text-sm leading-5 text-muted">Upload a photo or take one now.</p></div></li>
              <li className="flex gap-4 py-4"><span className="text-sm font-bold text-forest">02</span><div><p className="font-display font-bold text-ink">Check the details</p><p className="mt-1 text-sm leading-5 text-muted">Correct anything the poster reader missed.</p></div></li>
              <li className="flex gap-4 py-4"><span className="text-sm font-bold text-forest">03</span><div><p className="font-display font-bold text-ink">Save your event</p><p className="mt-1 text-sm leading-5 text-muted">Add it to Google Calendar or download it.</p></div></li>
            </ol>
          </section>
          <section className="mt-7 border-t border-line pt-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-gold-ink">Made for campus life</p>
              <h3 className="mt-2 font-display text-xl font-bold tracking-tight text-ink">Less squinting.<br/>More showing up.</h3>
              <p className="mt-2 text-sm leading-6 text-muted">Turn the details hiding in a busy flyer into an event you can actually keep track of.</p>
            </div>
            <div className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-xs text-muted"><span className="size-2 rounded-full bg-forest"/>Your image isnâ€™t stored in this app</div>
          </section>
        </aside>
        </div>

        {event && !isNotPoster && (
          <section className="event-ticket result-enter mt-10 px-5 py-5 sm:mt-12 sm:px-8 sm:py-7" aria-labelledby="result-heading">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-gold-ink">Event ticket</p>
                <h2 id="result-heading" className="mt-1 font-display text-2xl font-bold text-ink">Review before you go</h2>
                <p className="mt-1 text-sm text-muted">Tap any field to correct it before adding the event.</p>
              </div>
              <div className="confidence-tag inline-flex items-center gap-2 self-start border border-line px-2.5 py-1 text-ink">
                <span className={`size-2 rounded-full ${event.confidence === "high" ? "bg-forest" : event.confidence === "medium" ? "bg-gold" : "bg-danger"}`} />
                {event.confidence} confidence
              </div>
            </div>

            {showNotes && (
              <div role="status" className="mt-5 flex gap-3 border border-warning-border bg-warning-background px-4 py-3.5 text-sm text-warning-foreground">
                <WarningIcon />
                <div>
                  <p className="font-bold">Please double-check these details</p>
                  <p className="mt-0.5 leading-6">{event.notes?.trim() || "Gemma isnâ€™t fully sure about every detail. Check the date, time, and location against the poster."}</p>
                </div>
              </div>
            )}

            <div className="mt-6">
              <Field label="Event name" name="title" value={event.title} onChange={(e) => updateEvent(e.target)} valueClassName="event-title-control font-display text-2xl font-bold tracking-tight sm:text-3xl" />
            </div>

            <div className="ticket-stub -mx-5 mt-6 grid grid-cols-1 gap-4 px-5 py-5 sm:-mx-8 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] sm:px-8">
              <Field label="Date" name="date" type="date" value={event.date} onChange={(e) => updateEvent(e.target)} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start time" name="start_time" type="time" value={event.start_time} onChange={(e) => updateEvent(e.target)} />
                <Field label="End time" name="end_time" type="time" value={event.end_time} onChange={(e) => updateEvent(e.target)} />
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Location" name="location" value={event.location} onChange={(e) => updateEvent(e.target)} />
              <Field label="Description" name="description" multiline value={event.description} onChange={(e) => updateEvent(e.target)} />
            </div>

            <div className="mt-6 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row">
              <button
                type="button"
                disabled={!canAddToCalendar}
                onClick={() => window.open(calendarUrl(event), "_blank", "noopener,noreferrer")}
                className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-md bg-forest px-5 text-sm font-semibold text-white transition-colors hover:bg-gold hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CalendarIcon /> Add to Google Calendar
              </button>
              <button
                type="button"
                disabled={!canAddToCalendar}
                onClick={downloadIcs}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-forest bg-transparent px-5 text-sm font-semibold text-forest transition-colors hover:bg-forest hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest disabled:cursor-not-allowed disabled:opacity-50"
              >
                <DownloadIcon /> Download .ics
              </button>
            </div>
            <p className="mt-3 text-center text-xs text-muted">Calendar times use Africa/Accra. Review the event details before saving.</p>
          </section>
        )}

        {isNotPoster && (
          <div className="mt-8 flex gap-3 border border-line bg-paper p-5" role="status">
            <span className="grid size-10 shrink-0 place-items-center border border-line text-forest"><PosterIcon /></span>
            <div>
              <h2 className="font-display font-bold text-ink">That doesnâ€™t look like an event poster</h2>
              <p className="mt-1 text-sm leading-6 text-muted">Try a photo that clearly shows a campus event name, date, or venue. A sharper, well-lit picture usually works best.</p>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-line px-4 py-5 text-center text-xs text-muted">
        Powered by Gemma 4 (open-weights model)
      </footer>
    </div>
  );
}

function CalendarIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-5"><rect x="3.5" y="5.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8"/><path d="M7.5 3.5v4M16.5 3.5v4M4 9.5h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="m9 14 2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function UploadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-6"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function PosterIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-9"><rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="16" cy="16" r="1" fill="currentColor"/></svg>;
}

function WarningIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="mt-0.5 size-5 shrink-0"><path d="M12 3.5 21 19H3l9-15.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M12 9v4.5M12 17h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>;
}

function ArrowIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-4"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function DownloadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-5"><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4.5 16v3.5h15V16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function SunIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-4"><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7"/><path d="M12 2.5v2M12 19.5v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2.5 12h2m15 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
}

function MoonIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-4"><path d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export default App;
