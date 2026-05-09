function dashboard() {
  return {
    connected: false,
    score: {},
    radios: [],
    qsos: [],

    init() {
      const socket = io();

      socket.on('connect',    () => { this.connected = true; });
      socket.on('disconnect', () => { this.connected = false; });

      socket.on('radio:update', (data) => {
        const idx = this.radios.findIndex((r) => r.radio_nr === data.radio_nr);
        if (idx >= 0) this.radios[idx] = data;
        else this.radios.push(data);
        this.radios = [...this.radios];
      });

      socket.on('contact:new', (data) => {
        this.qsos = [data, ...this.qsos];
      });

      socket.on('score:update', (data) => {
        this.score = data;
      });

      socket.on('db:cleared', () => {
        this.qsos = [];
        this.score = {};
        this.radios = [];
      });

      this.fetchInitialState();
    },

    async fetchInitialState() {
      try {
        const [qsos, score, radios] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score').then((r) => r.json()),
          fetch('/api/radios').then((r) => r.json()),
        ]);
        this.qsos   = qsos;
        this.score  = score;
        this.radios = radios;
      } catch (err) {
        console.error('Failed to load initial state:', err);
      }
    },
  };
}
