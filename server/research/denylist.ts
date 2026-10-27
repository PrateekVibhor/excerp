/**
 * Domains blocked outright in discovery (spec decision 29, second layer beside the legitimacy check).
 * A match on the domain or any of its subdomains is refused whatever the page looks like. The owner can edit this list.
 */
export const DENYLIST = {
  /** Job boards and aggregators: they repost other employers' jobs. */
  aggregator: [
    'indeed.com', 'linkedin.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'simplyhired.com', 'careerbuilder.com', 'talent.com', 'jooble.org',
    'adzuna.com', 'lensa.com', 'builtin.com', 'wellfound.com', 'angel.co', 'dice.com', 'snagajob.com', 'jobs.com', 'remoterocketship.com', 'himalayas.app',
    'weworkremotely.com', 'remoteok.com', 'remote.co', 'flexjobs.com', 'otta.com', 'welcometothejungle.com', 'jobgether.com', 'jobrapido.com', 'jobisjob.com',
    'careerjet.com', 'jora.com', 'recruit.net', 'whatjobs.com', 'nexxt.com', 'theladders.com', 'ladders.com', 'hiring.cafe', 'workingnomads.com', 'wayup.com',
    'handshake.com', 'idealist.org', 'workatastartup.com', 'levels.fyi', 'simplify.jobs', 'jobright.ai', 'jobleads.com', 'learn4good.com', 'getwork.com',
    'welovesalt.com', 'jobtensor.com', 'tealhq.com', 'jobstreet.com', 'naukri.com', 'jobsora.com', 'neuvoo.com', 'jobtome.com', 'bebee.com', 'ihirehealth.com',
    'builtinsf.com', 'builtincolorado.com', 'builtinnyc.com', 'builtinchicago.com', 'builtinboston.com', 'builtinaustin.com', 'builtinla.com', 'builtinseattle.com',
    'oficareers.com', 'earnbetter.com', 'jobs.ycombinator.com', 'ycombinator.com', 'fdepulse.com', 'remotive.com', 'justremote.co', 'arc.dev', 'turing.com', 'toptal.com', 'upwork.com', 'fiverr.com',
  ],
  /** Job-description templates, résumé and salary sites, and articles about roles: never an employer's own posting. */
  template: [
    'betterteam.com', 'resources.workable.com', 'recruiterflow.com', 'jobdescriptions.net', 'jobhero.com', 'resumegenius.com', 'zety.com', 'novoresume.com',
    'resume.io', 'livecareer.com', 'myperfectresume.com', 'salary.com', 'payscale.com', 'zippia.com', 'comparably.com', 'ambitionbox.com', 'careeronestop.org',
    'bls.gov', 'onetonline.org', 'coursera.org', 'productschool.com', 'mindtheproduct.com', 'investopedia.com', 'wikipedia.org', 'medium.com', 'reddit.com',
    'quora.com', 'sites.google.com', 'boards.greenhouse.io/mergeapiintegrationsandbox', 'job-boards.greenhouse.io/mergeapiintegrationsandbox', 'indeed.com/hire', 'homebase.com', 'workstream.us', 'hiringlab.org', 'themuse.com', 'ladders.com', 'jobdescription-templates.com',
  ],
  /** Staffing and recruiting agencies: postings are for their clients, not the agency's own roles. */
  staffing: [
    'randstadusa.com', 'randstad.com', 'lhh.com', 'roberthalf.com', 'kforce.com', 'adecco.com', 'adeccousa.com', 'manpowergroup.com', 'manpower.com',
    'kellyservices.com', 'kellyservices.us', 'aerotek.com', 'teksystems.com', 'insightglobal.com', 'cybercoders.com', 'hays.com', 'apexsystems.com', 'volt.com',
    'judge.com', 'collabera.com', 'allegisgroup.com', 'modis.com', 'experis.com', 'spherion.com', 'expresspros.com', 'artech.com', 'rht.com', 'hirequest.com',
    'creativecircle.com', 'wizehire.com', 'weekday.works', 'apply.workable.com/weekday-1', 'jobot.com', 'motionrecruitment.com', 'robertwalters.com', 'michaelpage.com', 'kornferry.com', 'heidrick.com', 'spencerstuart.com',
  ],
} as const;

export type DenyCategory = keyof typeof DENYLIST;

/** Plain domains only (a path entry such as indeed.com/hire is covered by its domain), for a search's exclude_domains. */
export const DENY_DOMAINS: string[] = [...new Set(Object.values(DENYLIST).flat().filter((d) => !d.includes('/')))];
