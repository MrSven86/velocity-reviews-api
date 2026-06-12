// CLIENT REGISTRY
// Add every new client here. The refresh cron job loops through this list.
//
// id:       lowercase with dashes, used in /api/reviews?client=xxx
// query:    the Google Maps search term (business name + city + state)
// limit:    how many reviews to pull (6-10 is good)

export const clients = [
  {
    id: "jts-pressure-washing",
    query: "JT's Pressure Washing Wesley Chapel FL",
    limit: 8,
  },

  // ===== ADD NEW CLIENTS BELOW =====
  // {
  //   id: "client-name",
  //   query: "Business Name City State",
  //   limit: 8,
  // },
];
