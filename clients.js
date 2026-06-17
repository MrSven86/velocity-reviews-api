// CLIENT REGISTRY
// Add every new client here. The refresh cron job loops through this list.
//
// id:       lowercase with dashes, used in /api/reviews?client=xxx
// query:    the Google Maps search term (business name + city + state)
// limit:    how many reviews to pull (6-10 is good)

export const clients = [
  {
    id: "jts-pressure-washing",
    url: "https://www.google.com/maps/place/JT+Pressure+Washing/@34.1196423,-83.7433044,6z/data=!4m10!1m2!2m1!1sjt+pressure+washing!3m6!1s0x89c15f33dab11b9f:0x77b878aa1cf6b9be!8m2!3d40.234726!4d-74.6100993!15sChNqdCBwcmVzc3VyZSB3YXNoaW5nWhUiE2p0IHByZXNzdXJlIHdhc2hpbmeSARhwcmVzc3VyZV93YXNoaW5nX3NlcnZpY2XgAQA!16s%2Fg%2F11ftm1_0fx?entry=ttu&g_ep=EgoyMDI2MDYwOS4wIKXMDSoASAFQAw%3D%3D",
    limit: 48,
  },

  // ===== ADD NEW CLIENTS BELOW =====
  {
    id: "mb-plumbing-columbus",
    url: "https://www.google.com/maps/place/MB+Plumbing/@39.9831679,-83.1556224,11z/data=!4m10!1m2!2m1!1sMB+Plumbing,+Columbus+OH+!3m6!1s0x88388fb6ebe88335:0xbcc88ced2209793!8m2!3d39.9378873!4d-82.997114!15sChhNQiBQbHVtYmluZywgQ29sdW1idXMgT0iSAQdwbHVtYmVy4AEA!16s%2Fg%2F11jp043gg8",
    limit: 48,
  },
];
