import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useAuth } from '../contexts/AuthContext';
import apiService from '../services/api';
import '../styles/Auth.css' // Import file CSS mới

function LoginPage() {
  const { register, handleSubmit, formState: { errors } } = useForm();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [apiError, setApiError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (containerRef.current) {
        containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const onSubmit = async (data) => {
    setShowPassword(false);
    setLoading(true);
    setApiError(null);
    try {
      const loginResponse = await apiService.login(data.email, data.password);
      const { token, user } = loginResponse.data;

      if (!token || !user) throw new Error('Phản hồi từ server không hợp lệ');
      
      login(user, token, data.rememberMe);
      navigate('/');
    } catch (error) {
      if (error.response && (error.response.status === 401 || error.response.status === 400)) {
        setApiError('Email hoặc mật khẩu không chính xác.');
      } else {
        setApiError('Đã có lỗi xảy ra. Vui lòng thử lại.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page-wrapper" ref={containerRef}>
      {/* Cột Form Đăng Nhập */}
      <div className="auth-form-col">
        <div className="auth-bg-shape shape-1"></div>
        <div className="auth-bg-shape shape-2"></div>
        <div className="auth-bg-shape shape-3"></div>
        <div className="auth-form-container">
          <Link to="/" className="auth-logo">
            <i className="fas fa-box-open"></i> RentalP2P
          </Link>
          
          <h1 className="auth-title">Chào mừng trở lại! 👋</h1>
          <p className="auth-subtitle">Vui lòng đăng nhập để tiếp tục trải nghiệm dịch vụ thuê đồ của chúng tôi.</p>

          <form onSubmit={handleSubmit(onSubmit)}>
            {apiError && (
              <div className="alert alert-danger" style={{ borderRadius: '12px' }} role="alert">
                <i className="fas fa-exclamation-circle me-2"></i>{apiError}
              </div>
            )}

            <div className="auth-input-group">
              <input 
                type="email" 
                className={`auth-input ${errors.email ? 'is-invalid' : ''}`}
                placeholder="Địa chỉ Email"
                autoComplete="username"
                {...register('email', { 
                  required: 'Email là bắt buộc',
                  pattern: {
                    value: /^\S+@\S+$/i,
                    message: "Định dạng email không hợp lệ"
                  }
                })}
              />
              <i className="fas fa-envelope"></i>
              {errors.email && <div className="auth-invalid-feedback">{errors.email.message}</div>}
            </div>

            <div className="auth-input-group">
              <div className="auth-password-field">
                <label htmlFor="login-password" className="visually-hidden">Mật khẩu</label>
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  className={`auth-input ${errors.password ? 'is-invalid' : ''}`}
                  placeholder="Mật khẩu"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-required="true"
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'login-password-error' : undefined}
                  {...register('password', { required: 'Mật khẩu là bắt buộc' })}
                />
                <i className="fas fa-lock" aria-hidden="true" />
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label="Hiện mật khẩu"
                  aria-pressed={showPassword}
                  aria-controls="login-password"
                  title={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  <span className={`fas ${showPassword ? 'fa-eye-slash' : 'fa-eye'}`} aria-hidden="true" />
                </button>
              </div>
              {errors.password && (
                <div id="login-password-error" className="auth-invalid-feedback">{errors.password.message}</div>
              )}
            </div>

            <div className="d-flex justify-content-between align-items-center mb-4 mt-2">
              <div className="form-check">
                <input
                  type="checkbox"
                  className="form-check-input"
                  id="rememberMe"
                  {...register('rememberMe')}
                />
                <label className="form-check-label text-muted fs-7" htmlFor="rememberMe">Ghi nhớ tôi</label>
              </div>
              <Link to="/forgot-password" className="auth-link fs-7">Quên mật khẩu?</Link>
            </div>

            <button type="submit" className="auth-btn-submit" disabled={loading}>
              {loading ? (
                <><span className="spinner-border spinner-border-sm me-2"></span> Đang xử lý...</>
              ) : (
                'Đăng Nhập'
              )}
            </button>

            <p className="text-center mt-4 text-muted">
              Chưa có tài khoản? <Link to="/register" className="auth-link">Đăng ký ngay</Link>
            </p>
          </form>
        </div>
      </div>

      {/* Cột Hình ảnh (Ẩn trên mobile) */}
      <div className="auth-image-col">
        {/* Bạn có thể thay link ảnh này bằng ảnh chụp đồ nghề/cắm trại của bạn */}
        <img 
          src="/img/loginbanner.webp" 
          alt="Camping Equipment" 
          className="auth-image-bg" 
        />
        <div className="auth-image-overlay">
          <h2>Khám phá vô hạn.</h2>
          <p>Hàng ngàn món đồ chất lượng từ máy ảnh, đồ cắm trại đến dụng cụ làm mộc đang chờ bạn khám phá và thuê với mức giá cực tốt.</p>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
