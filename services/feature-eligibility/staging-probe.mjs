export default {
  async fetch() {
    return Response.json({ error: 'eligibility_unavailable' }, { status: 503 });
  }
};
