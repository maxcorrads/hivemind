import { useEffect, useRef, useState } from "react";
import { isLiveSearchQuery } from "../src/shared/search-query.ts";
import type { Project, SearchHit } from "../src/shared/types.ts";
import { api } from "./api.ts";

/** The sidebar query: filters the navigation and, once it is a live search, pages message hits of the selected project. */
export function useSearch({ selectedProject, projects, setErr }: {
  selectedProject: string;
  projects: Project[];
  setErr: (error: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitsMore, setHitsMore] = useState(false);
  const [hitsBusy, setHitsBusy] = useState(false);
  const [searchTick, setSearchTick] = useState(0);
  const searchDelayRef = useRef(280);
  const hitsNeedleRef = useRef("");
  const hitsProjectRef = useRef("");
  const olderLoad = useRef<AbortController | null>(null);
  const searching = isLiveSearchQuery(query);
  const searchProjectOk = projects.some((p) => p.slug === selectedProject);

  useEffect(() => {
    olderLoad.current?.abort();
    olderLoad.current = null;
    if (!searching || !searchProjectOk) {
      hitsNeedleRef.current = "";
      hitsProjectRef.current = "";
      setHits([]);
      setHitsMore(false);
      setHitsBusy(false);
      return;
    }
    const needle = query.trim();
    const project = selectedProject;
    const ac = new AbortController();
    setHits([]);
    setHitsMore(false);
    setHitsBusy(true);
    const delay = searchDelayRef.current;
    searchDelayRef.current = 280;
    const timer = window.setTimeout(() => {
      api
        .search(needle, project, undefined, undefined, ac.signal)
        .then((page) => {
          if (ac.signal.aborted) return;
          hitsNeedleRef.current = needle;
          hitsProjectRef.current = project;
          setHits(page.hits);
          setHitsMore(page.hasMore);
        })
        .catch((e) => {
          if (ac.signal.aborted || e.name === "AbortError") return;
          setErr(String(e.message || e));
        })
        .finally(() => {
          if (!ac.signal.aborted) setHitsBusy(false);
        });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [searching, query, selectedProject, searchProjectOk, searchTick]);

  /** Enter skips the typing debounce. */
  const searchNow = () => {
    searchDelayRef.current = 0;
    setSearchTick((n) => n + 1);
  };

  /** One older page at a time; a new query aborts it. */
  const loadOlderHits = () => {
    const needle = hitsNeedleRef.current;
    const project = hitsProjectRef.current;
    const oldest = hits[hits.length - 1]?.seq;
    if (!needle || !project || !oldest || olderLoad.current) return;
    const ac = new AbortController();
    olderLoad.current = ac;
    api
      .search(needle, project, oldest, undefined, ac.signal)
      .then((page) => {
        if (ac.signal.aborted || hitsNeedleRef.current !== needle || hitsProjectRef.current !== project) return;
        setHits((cur) => {
          const seen = new Set(cur.map((x) => x.seq));
          return [...cur, ...page.hits.filter((h) => !seen.has(h.seq))];
        });
        setHitsMore(page.hasMore);
      })
      .catch((e) => {
        if (ac.signal.aborted || e.name === "AbortError") return;
        setErr(String(e.message || e));
      })
      .finally(() => {
        if (olderLoad.current === ac) olderLoad.current = null;
      });
  };

  return { query, setQuery, hits, hitsMore, hitsBusy, searching, searchNow, loadOlderHits };
}
