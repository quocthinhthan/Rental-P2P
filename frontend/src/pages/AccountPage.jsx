import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import apiService from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import DesktopEkycPanel from '../components/Ekyc/DesktopEkycPanel';
import Swal from 'sweetalert2';
import '../styles/AccountPage.css';

function AccountPage() {
  const { user, updateUser } = useAuth();
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors }
  } = useForm();

  const [saving, setSaving] = useState(false);
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const avatarInputRef = useRef(null);
  const uploadedAvatarUrl = useRef('');
  const displayedAvatar = avatarPreview || user?.avatarUrl;

  const isVerified = user?.ekycStatus === 'verified'
    && (!user?.ekycExpiresAt || new Date(user.ekycExpiresAt) > new Date());

  useEffect(() => {
    if (!user) return;
    setValue('fullName', user.fullName || '');
    setValue('email', user.email || '');
    setValue('phoneNumber', user.phoneNumber || '');
    setValue('address', user.address || '');
    setValue('bankAccount.bankName', user.bankAccount?.bankName || '');
    setValue('bankAccount.accountNumber', user.bankAccount?.accountNumber || '');
    setValue('bankAccount.accountHolder', user.bankAccount?.accountHolder || '');
  }, [user, setValue]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview('');
      return;
    }

    const previewUrl = URL.createObjectURL(avatarFile);
    setAvatarPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [avatarFile]);

  const handleAvatarChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    uploadedAvatarUrl.current = '';
    setAvatarFile(file);
  };

  const handleVerifiedSuccess = useCallback((freshUser) => {
    if (!freshUser) return;
    updateUser(freshUser);
    if (freshUser.fullName) setValue('fullName', freshUser.fullName);
    if (freshUser.address) setValue('address', freshUser.address);
  }, [updateUser, setValue]);

  const onSubmit = async (data) => {
    setSaving(true);

    try {
      const payload = {
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        address: data.address,
        bankAccount: {
          bankName: data.bankAccount?.bankName || '',
          accountNumber: data.bankAccount?.accountNumber || '',
          accountHolder: data.bankAccount?.accountHolder || ''
        }
      };

      if (avatarFile) {
        // Reuse the upload if only the subsequent profile update needs retrying.
        if (!uploadedAvatarUrl.current) {
          const response = await apiService.uploadImage(avatarFile);
          if (!response.data?.imageUrl) {
            Swal.fire('Thất bại', 'Không thể tải ảnh đại diện lên. Vui lòng thử lại.', 'error');
            return;
          }
          uploadedAvatarUrl.current = response.data.imageUrl;
        }
        payload.avatarUrl = uploadedAvatarUrl.current;
      }

      const response = await apiService.updateProfile(payload);
      updateUser(response.data);
      setAvatarFile(null);
      uploadedAvatarUrl.current = '';
      if (avatarInputRef.current) avatarInputRef.current.value = '';
      Swal.fire('Thành công!', 'Cập nhật thông tin thành công!', 'success');
    } catch (error) {
      Swal.fire('Thất bại', error.response?.data?.message || 'Không thể cập nhật thông tin.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* ── Page Header ── */}
      <div className="container-fluid page-header py-5">
        <h1 className="text-center text-white display-6 wow fadeInUp" data-wow-delay="0.1s">
          Tài khoản của tôi
        </h1>
        <ol className="breadcrumb justify-content-center mb-0 wow fadeInUp" data-wow-delay="0.3s">
          <li className="breadcrumb-item"><Link to="/">Trang chủ</Link></li>
          <li className="breadcrumb-item active text-white">Tài khoản</li>
        </ol>
      </div>

      {/* ── Main Content ── */}
      <div className="acc-page-bg">
        <div className="container">
          <div className="row g-4 align-items-start">

            {/* ── LEFT: Profile Sidebar ── */}
            <div className="col-lg-4">
              <div className="acc-profile-card">
                <div className="acc-avatar-wrap">
                  {displayedAvatar ? (
                    <img
                      src={displayedAvatar}
                      alt={user?.fullName}
                      className="acc-avatar"
                    />
                  ) : (
                    <div className="acc-avatar-placeholder">
                      <i className="fa fa-user" />
                    </div>
                  )}
                  {isVerified && (
                    <div className="acc-verified-badge" title="Đã xác thực eKYC">
                      <i className="fas fa-check" />
                    </div>
                  )}
                </div>

                <div className="acc-user-name">{user?.fullName || 'Người dùng'}</div>
                <div className="acc-user-email mb-3">{user?.email}</div>

                <div className="d-flex justify-content-center mb-3">
                  <span className={`acc-status-badge ${isVerified ? 'verified' : 'unverified'}`}>
                    <i className={`fas ${isVerified ? 'fa-shield-alt' : 'fa-clock'}`} />
                    {isVerified ? 'Đã xác thực eKYC' : 'Chưa xác thực'}
                  </span>
                </div>

                {user?.phoneNumber && (
                  <div className="text-center text-muted" style={{ fontSize: '.85rem' }}>
                    <i className="fas fa-phone-alt text-success me-1" />{user.phoneNumber}
                  </div>
                )}

                {user?.address && (
                  <div className="text-center text-muted mt-1" style={{ fontSize: '.85rem' }}>
                    <i className="fas fa-map-marker-alt text-danger me-1" />{user.address}
                  </div>
                )}

                <div className="acc-sidebar-info mt-3">
                  <div><i className="fas fa-info-circle" />Cập nhật thông tin để tăng uy tín khi thuê/cho thuê trên nền tảng.</div>
                  {!isVerified && (
                    <div className="mt-2">
                      <i className="fas fa-exclamation-triangle text-warning" />
                      <span className="text-warning fw-medium">Xác minh danh tính (eKYC) để mở đầy đủ tính năng thuê và cho thuê.</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── RIGHT: Form & eKYC ── */}
            <div className="col-lg-8">
              <div className="acc-form-card">
                {/* ── Section: eKYC (Highlighted at top when unverified, or clean verified banner) ── */}
                <div className="acc-section-title">
                  <i className="fas fa-id-card" />Xác minh danh tính (eKYC)
                </div>

                <div className="mb-4">
                  <DesktopEkycPanel
                    user={user}
                    onVerifiedSuccess={handleVerifiedSuccess}
                  />
                </div>

                <hr className="acc-divider" />

                <form onSubmit={handleSubmit(onSubmit)}>

                  {/* ── Section: Thông tin cơ bản ── */}
                  <div className="acc-section-title">
                    <i className="fas fa-user-edit" />Thông tin cá nhân
                  </div>

                  <div className="row g-3 mb-3">
                    <div className="col-md-6">
                      <label className="form-label">Họ và tên <sup className="text-danger">*</sup></label>
                      <input
                        type="text"
                        className={`form-control ${errors.fullName ? 'is-invalid' : ''}`}
                        placeholder="Nguyễn Văn A"
                        readOnly={isVerified}
                        {...register('fullName', { required: 'Vui lòng nhập họ và tên' })}
                      />
                      {errors.fullName && <div className="invalid-feedback">{errors.fullName.message}</div>}
                      {isVerified && (
                        <div className="form-text text-success small mt-1">
                          <i className="fas fa-lock me-1" /> Họ tên đã khóa theo hồ sơ eKYC (không thể tự chỉnh sửa).
                        </div>
                      )}
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Email</label>
                      <input
                        type="email"
                        className="form-control"
                        readOnly
                        {...register('email')}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Số điện thoại <sup className="text-danger">*</sup></label>
                      <input
                        type="tel"
                        className={`form-control ${errors.phoneNumber ? 'is-invalid' : ''}`}
                        placeholder="09xxxxxxxx"
                        {...register('phoneNumber', {
                          required: 'Vui lòng nhập số điện thoại',
                          pattern: {
                            value: /^0\d{9,10}$/,
                            message: 'Số điện thoại không hợp lệ'
                          }
                        })}
                      />
                      {errors.phoneNumber && <div className="invalid-feedback">{errors.phoneNumber.message}</div>}
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Địa chỉ</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="Quận, Thành phố..."
                        {...register('address')}
                      />
                    </div>
                  </div>

                  {/* ── Section: Thông tin ngân hàng ── */}
                  <div className="acc-section-title mt-4">
                    <i className="fas fa-university" />Thông tin ngân hàng nhận hoàn cọc
                  </div>

                  <div className="row g-3 mb-3">
                    <div className="col-md-4">
                      <label className="form-label">Tên ngân hàng</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="Vietcombank, MB, Techcombank..."
                        {...register('bankAccount.bankName')}
                      />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label">Số tài khoản</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="1234567890"
                        {...register('bankAccount.accountNumber')}
                      />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label">Tên chủ tài khoản</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="NGUYEN VAN A"
                        {...register('bankAccount.accountHolder')}
                      />
                    </div>
                  </div>

                  {/* ── Section: Avatar ── */}
                  <div className="acc-section-title mt-4">
                    <i className="fas fa-camera" />Ảnh đại diện
                  </div>

                  <div className="row g-3">
                    <div className="col-md-6">
                      <label className="form-label" htmlFor="account-avatar-file">Chọn ảnh từ máy</label>
                      <input
                        id="account-avatar-file"
                        name="avatarFile"
                        type="file"
                        accept="image/*"
                        className="form-control"
                        aria-describedby="account-avatar-help"
                        ref={avatarInputRef}
                        disabled={saving}
                        onChange={handleAvatarChange}
                      />
                      <div id="account-avatar-help" className="form-text">
                        Ảnh được tải lên khi bạn bấm Lưu thay đổi.
                      </div>
                      {displayedAvatar && (
                        <img
                          src={displayedAvatar}
                          alt={avatarPreview ? 'Ảnh đại diện xem trước' : 'Ảnh đại diện hiện tại'}
                          className="acc-avatar-preview"
                        />
                      )}
                    </div>
                  </div>

                  {/* ── Submit ── */}
                  <div className="mt-4 d-flex justify-content-end gap-3 align-items-center">
                    {saving && (
                      <span className="text-muted small" role="status">
                        <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />Đang lưu...
                      </span>
                    )}
                    <button type="submit" className="acc-submit-btn" disabled={saving}>
                      <i className="fas fa-save me-2" />
                      {saving ? 'Đang lưu...' : 'Lưu thay đổi'}
                    </button>
                  </div>

                </form>
              </div>
            </div>
            {/* /col right */}

          </div>
        </div>
      </div>
    </>
  );
}

export default AccountPage;
