/**
 * The registry of Nango-backed adapters — ONE import and ONE entry per
 * adapter, alphabetical by connector id. Batches of providers are built in
 * parallel; this file is the only one they share, and a one-line append is
 * the whole merge.
 *
 * Adding a provider: `docs/integrations-nango.md` → "Adding a provider".
 */
import type { NangoAdapter } from "./shared";
import { airtableAdapter } from "./airtable";
import { amplitudeAdapter } from "./amplitude";
import { asanaAdapter } from "./asana";
import { ashbyAdapter } from "./ashby";
import { attioAdapter } from "./attio";
import { bamboohrAdapter } from "./bamboohr";
import { basecampAdapter } from "./basecamp";
import { bigqueryAdapter } from "./bigquery";
import { bitbucketAdapter } from "./bitbucket";
import { boxAdapter } from "./box";
import { brexAdapter } from "./brex";
import { calComAdapter } from "./cal-com";
import { calendlyAdapter } from "./calendly";
import { canvaAdapter } from "./canva";
import { chorusAdapter } from "./chorus";
import { clickupAdapter } from "./clickup";
import { cloudflareAdapter } from "./cloudflare";
import { codaAdapter } from "./coda";
import { confluenceAdapter } from "./confluence";
import { contentfulAdapter } from "./contentful";
import { datadogAdapter } from "./datadog";
import { deelAdapter } from "./deel";
import { discordAdapter } from "./discord";
import { docusignAdapter } from "./docusign";
import { dropboxAdapter } from "./dropbox";
import { dropboxSignAdapter } from "./dropbox-sign";
import { figmaAdapter } from "./figma";
import { firefliesAdapter } from "./fireflies";
import { freshdeskAdapter } from "./freshdesk";
import { frontAdapter } from "./front";
import { githubNangoAdapter } from "./github-nango";
import { githubPatAdapter } from "./github-pat";
import { gitlabAdapter } from "./gitlab";
import { gmailAdapter } from "./gmail";
import { gongAdapter } from "./gong";
import { googleAnalyticsAdapter } from "./google-analytics";
import { googleCalendarAdapter } from "./google-calendar";
import { googleChatAdapter } from "./google-chat";
import { googleDocsAdapter } from "./google-docs";
import { googleDriveAdapter } from "./google-drive";
import { googleFormsAdapter } from "./google-forms";
import { googleMeetAdapter } from "./google-meet";
import { googleSheetsAdapter } from "./google-sheets";
import { googleSlidesAdapter } from "./google-slides";
import { googleTasksAdapter } from "./google-tasks";
import { gorgiasAdapter } from "./gorgias";
import { grafanaAdapter } from "./grafana";
import { grainAdapter } from "./grain";
import { greenhouseAdapter } from "./greenhouse";
import { gustoAdapter } from "./gusto";
import { helpscoutAdapter } from "./helpscout";
import { hibobAdapter } from "./hibob";
import { hubspotAdapter } from "./hubspot";
import { intercomAdapter } from "./intercom";
import { jiraAdapter } from "./jira";
import { jotformAdapter } from "./jotform";
import { latticeAdapter } from "./lattice";
import { leverAdapter } from "./lever";
import { linearNangoAdapter } from "./linear-nango";
import { linkedinAdapter } from "./linkedin";
import { mailchimpAdapter } from "./mailchimp";
import { makeAdapter } from "./make";
import { meetingRecordsNangoAdapter } from "./meeting-records-nango";
import { microsoftExcelAdapter } from "./microsoft-excel";
import { microsoftPlannerAdapter } from "./microsoft-planner";
import { microsoftPowerBiAdapter } from "./microsoft-power-bi";
import { microsoftTeamsAdapter } from "./microsoft-teams";
import { microsoftWordAdapter } from "./microsoft-word";
import { miroAdapter } from "./miro";
import { mixpanelAdapter } from "./mixpanel";
import { mondayAdapter } from "./monday";
import { n8nAdapter } from "./n8n";
import { notionNangoAdapter } from "./notion-nango";
import { oktaAdapter } from "./okta";
import { onedriveAdapter } from "./onedrive";
import { outlookAdapter } from "./outlook";
import { pagerdutyAdapter } from "./pagerduty";
import { pandadocAdapter } from "./pandadoc";
import { personioAdapter } from "./personio";
import { pipedriveAdapter } from "./pipedrive";
import { posthogAdapter } from "./posthog";
import { quickbooksAdapter } from "./quickbooks";
import { rampAdapter } from "./ramp";
import { ripplingAdapter } from "./rippling";
import { salesforceAdapter } from "./salesforce";
import { sentryAdapter } from "./sentry";
import { servicenowAdapter } from "./servicenow";
import { sharepointAdapter } from "./sharepoint";
import { shopifyAdapter } from "./shopify";
import { slackNangoAdapter } from "./slack-nango";
import { smartsheetAdapter } from "./smartsheet";
import { snowflakeAdapter } from "./snowflake";
import { stripeAdapter } from "./stripe";
import { supabaseAdapter } from "./supabase";
import { tallyAdapter } from "./tally";
import { tldvAdapter } from "./tldv";
import { todoistAdapter } from "./todoist";
import { trelloAdapter } from "./trello";
import { typeformAdapter } from "./typeform";
import { vercelAdapter } from "./vercel";
import { vimeoAdapter } from "./vimeo";
import { webflowAdapter } from "./webflow";
import { whatsappAdapter } from "./whatsapp";
import { workableAdapter } from "./workable";
import { workdayAdapter } from "./workday";
import { wrikeAdapter } from "./wrike";
import { xeroAdapter } from "./xero";
import { youtubeAdapter } from "./youtube";
import { zapierAdapter } from "./zapier";
import { zendeskAdapter } from "./zendesk";
import { zohoCrmAdapter } from "./zoho-crm";
import { zoomAdapter } from "./zoom";

export type { FetchChangesArgs, FetchChangesResult, NangoAdapter } from "./shared";

export const NANGO_ADAPTERS: readonly NangoAdapter[] = [
  airtableAdapter,
  amplitudeAdapter,
  asanaAdapter,
  ashbyAdapter,
  attioAdapter,
  bamboohrAdapter,
  basecampAdapter,
  bigqueryAdapter,
  bitbucketAdapter,
  boxAdapter,
  brexAdapter,
  calComAdapter,
  calendlyAdapter,
  canvaAdapter,
  chorusAdapter,
  clickupAdapter,
  cloudflareAdapter,
  codaAdapter,
  confluenceAdapter,
  contentfulAdapter,
  datadogAdapter,
  deelAdapter,
  discordAdapter,
  docusignAdapter,
  dropboxAdapter,
  dropboxSignAdapter,
  figmaAdapter,
  firefliesAdapter,
  freshdeskAdapter,
  frontAdapter,
  githubNangoAdapter,
  githubPatAdapter,
  gitlabAdapter,
  gmailAdapter,
  gongAdapter,
  googleAnalyticsAdapter,
  googleCalendarAdapter,
  googleChatAdapter,
  googleDocsAdapter,
  googleDriveAdapter,
  googleFormsAdapter,
  googleMeetAdapter,
  googleSheetsAdapter,
  googleSlidesAdapter,
  googleTasksAdapter,
  gorgiasAdapter,
  grafanaAdapter,
  grainAdapter,
  greenhouseAdapter,
  gustoAdapter,
  helpscoutAdapter,
  hibobAdapter,
  hubspotAdapter,
  intercomAdapter,
  jiraAdapter,
  jotformAdapter,
  latticeAdapter,
  leverAdapter,
  linearNangoAdapter,
  linkedinAdapter,
  mailchimpAdapter,
  makeAdapter,
  meetingRecordsNangoAdapter,
  microsoftExcelAdapter,
  microsoftPlannerAdapter,
  microsoftPowerBiAdapter,
  microsoftTeamsAdapter,
  microsoftWordAdapter,
  miroAdapter,
  mixpanelAdapter,
  mondayAdapter,
  n8nAdapter,
  notionNangoAdapter,
  oktaAdapter,
  onedriveAdapter,
  outlookAdapter,
  pagerdutyAdapter,
  pandadocAdapter,
  personioAdapter,
  pipedriveAdapter,
  posthogAdapter,
  quickbooksAdapter,
  rampAdapter,
  ripplingAdapter,
  salesforceAdapter,
  sentryAdapter,
  servicenowAdapter,
  sharepointAdapter,
  shopifyAdapter,
  slackNangoAdapter,
  smartsheetAdapter,
  snowflakeAdapter,
  stripeAdapter,
  supabaseAdapter,
  tallyAdapter,
  tldvAdapter,
  todoistAdapter,
  trelloAdapter,
  typeformAdapter,
  vercelAdapter,
  vimeoAdapter,
  webflowAdapter,
  whatsappAdapter,
  workableAdapter,
  workdayAdapter,
  wrikeAdapter,
  xeroAdapter,
  youtubeAdapter,
  zapierAdapter,
  zendeskAdapter,
  zohoCrmAdapter,
  zoomAdapter,
];
