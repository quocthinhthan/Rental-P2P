// frontend/src/services/ekycSocket.js
import { io } from 'socket.io-client';

const TOKEN_KEY = 'token';

const getStoredToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

const getSocketUrl = () => {
  if (import.meta.env.REACT_APP_SOCKET_URL) {
    return import.meta.env.REACT_APP_SOCKET_URL;
  }

  const apiUrl = import.meta.env.REACT_APP_API_URL || 'http://localhost/api';
  return apiUrl.replace(/\/api\/?$/, '');
};

export const createEkycSessionSocket = () => io(getSocketUrl(), {
  autoConnect: false,
  auth: {
    token: getStoredToken(),
  },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1500,
});
