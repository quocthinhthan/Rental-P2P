import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Swal from 'sweetalert2';
import { getAdminItemReports, resolveAdminItemReport, updateAdminItemStatus } from '../services/api';
import Spinner from '../components/Common/Spinner';
import CustomSelect from '../components/Common/CustomSelect';
import AdminHero from '../components/Admin/AdminHero';
import { formatDateTime, getErrorMessage, getName } from '../components/Admin/AdminDisputeResolutionForm';
import { itemStatusLabels } from '../constants/rentalUi';
import { formatItemCode } from '../utils/itemCode';
import '../styles/AdminDisputesPage.css';
import '../styles/AdminDashboardPage.css';
import '../styles/AdminProductManagement.css';

const STATUS_OPTIONS = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'pending', label: 'Chờ xử lý' },
  { value: 'resolved', label: 'Đã xử lý' },
  { value: 'rejected', label: 'Không xử lý thêm' },
];

const ACTION_OPTIONS = [
  { value: 'no_action', label: 'Không xử lý thêm' },
  { value: 'hide_item', label: 'Ẩn sản phẩm' },
  { value: 'delist_item', label: 'Gỡ sản phẩm' },
  { value: 'ban_item', label: 'Gỡ sản phẩm và phạt chủ sở hữu' },
  { value: 'warn_owner', label: 'Cảnh báo chủ sở hữu' },
];

const SORT_OPTIONS = [
  { value: 'created_desc', label: 'Mới nhất' },
  { value: 'status_asc', label: 'Trạng thái' },
  { value: 'action_asc', label: 'Hướng xử lý' },
];

const REPORT_STATUS_LABELS = {
  pending: 'Chờ xử lý',
  resolved: 'Đã xử lý',
};

const REPORT_STATUS_CLASSES = {
  pending: 'aip-pill--pending',
  resolved: 'aip-pill--available',
};

const ACTION_LABELS = ACTION_OPTIONS.reduce((labels, option) => {
  labels[option.value] = option.label;
  return labels;
}, {});

const ADJUST_ITEM_STATUS_OPTIONS = [
  { value: 'available', label: 'Đang hoạt động (AVAILABLE)' },
  { value: 'delisted', label: 'Đã gỡ (DELISTED)' },
];

const getId = (value) => (typeof value === 'string' ? value : value?._id || value?.id || '');
const getItemImage = (item) => (Array.isArray(item?.images) && item.images[0]) || '/img/product-1.png';

export default function AdminItemReportsPage() {
  const [reports, setReports] = useState([]);
  const [pagination, setPagination] = useState({});
  const [resolveModal, setResolveModal] = useState(null);
  const [modalValidationError, setModalValidationError] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('created_desc');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

  const backendStatus = status === 'rejected' ? 'resolved' : status;

  const fetchReports = useCallback(async () => {
    try {
      setLoading(true);
      const response = await getAdminItemReports({ page, limit: 20, status: backendStatus });
      setReports(Array.isArray(response.data?.reports) ? response.data.reports : []);
      setPagination(response.data?.pagination || {});
    } catch (error) {
      Swal.fire('Lỗi!', getErrorMessage(error, 'Không thể tải danh sách báo cáo sản phẩm.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [page, backendStatus]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const visibleReports = useMemo(() => {
    let rows = [...reports];
    if (status === 'rejected') {
      rows = rows.filter((report) => report.action === 'no_action');
    }
    const sorters = {
      status_asc: (a, b) => (a.status || '').localeCompare(b.status || '', 'vi'),
      action_asc: (a, b) => (a.action || '').localeCompare(b.action || '', 'vi'),
      created_desc: (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    };
    return rows.sort(sorters[sort] || sorters.created_desc);
  }, [reports, sort, status]);

  const reportStats = useMemo(() => {
    const pending = reports.filter((report) => report.status === 'pending').length;
    const resolved = reports.filter((report) => report.status === 'resolved').length;
    const noAction = reports.filter((report) => report.action === 'no_action').length;
    return { pending, resolved, noAction };
  }, [reports]);

  const changeStatus = (value) => {
    setStatus(value);
    setPage(1);
  };

  const handleResolve = (report) => {
    const isAlreadyResolved = report.status === 'resolved';
    const item = report.itemId || {};
    const itemId = item._id || item.id;

    setModalValidationError('');

    if (isAlreadyResolved) {
      setResolveModal({
        mode: 'adjust_status',
        report,
        itemId,
        originalActionLabel: ACTION_LABELS[report.action] || 'Không xử lý thêm',
        selectedValue: item.status || 'available',
        note: '',
      });
      return;
    }

    setResolveModal({
      mode: 'resolve_report',
      report,
      itemId,
      selectedValue: report.action || 'no_action',
      note: report.resolutionNote || report.adminNote || '',
    });
  };

  const handleCloseResolveModal = () => {
    if (actionLoading) return;
    setResolveModal(null);
    setModalValidationError('');
  };

  const handleSubmitResolveModal = async (event) => {
    event.preventDefault();
    if (!resolveModal) return;

    const trimmedNote = resolveModal.note.trim();
    if (!trimmedNote) {
      setModalValidationError(
        resolveModal.mode === 'adjust_status'
          ? 'Vui lòng nhập lý do điều chỉnh.'
          : 'Vui lòng nhập ghi chú xử lý.'
      );
      return;
    }

    setModalValidationError('');
    const { mode, report, itemId, selectedValue } = resolveModal;

    try {
      setActionLoading(report._id);
      if (mode === 'adjust_status') {
        await updateAdminItemStatus(itemId, {
          status: selectedValue,
          reason: trimmedNote,
        });
        setResolveModal(null);
        Swal.fire('Thành công!', 'Trạng thái sản phẩm đã được điều chỉnh thành công.', 'success');
      } else {
        await resolveAdminItemReport(report._id, {
          action: selectedValue,
          adminNote: trimmedNote,
          resolutionNote: trimmedNote,
        });
        setResolveModal(null);
        Swal.fire('Thành công!', 'Báo cáo sản phẩm đã được xử lý thành công.', 'success');
      }
      await fetchReports();
    } catch (error) {
      Swal.fire(
        'Thất bại',
        getErrorMessage(
          error,
          mode === 'adjust_status'
            ? 'Không thể điều chỉnh trạng thái sản phẩm.'
            : 'Không thể xử lý báo cáo sản phẩm.'
        ),
        'error'
      );
    } finally {
      setActionLoading('');
    }
  };

  const handleQuickDismiss = async (report) => {
    const result = await Swal.fire({
      title: 'Xác nhận bỏ qua nhanh? 🤔',
      text: 'Báo cáo này sẽ được duyệt nhanh với hướng xử lý "Không xử lý thêm" mà không phạt chủ sở hữu hoặc ẩn sản phẩm.',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Đồng ý',
      cancelButtonText: 'Hủy bỏ',
      confirmButtonColor: '#10b981',
      cancelButtonColor: '#6c757d'
    });

    if (!result.isConfirmed) return;

    try {
      setActionLoading(report._id);
      await resolveAdminItemReport(report._id, {
        action: 'no_action',
        adminNote: 'Đã phê duyệt nhanh: Không phát hiện vi phạm sau khi rà soát.',
        resolutionNote: 'Đã phê duyệt nhanh: Không phát hiện vi phạm sau khi rà soát.',
      });
      Swal.fire('Thành công! 🎉', 'Báo cáo sản phẩm đã được phê duyệt bỏ qua nhanh.', 'success');
      await fetchReports();
    } catch (error) {
      Swal.fire('Thất bại', getErrorMessage(error, 'Không thể xử lý nhanh báo cáo sản phẩm.'), 'error');
    } finally {
      setActionLoading('');
    }
  };

  return (
    <main className="admin-products-page admin-shell-page">
      <AdminHero
        eyebrow="Quản trị hệ thống"
        title="Báo cáo sản phẩm"
        description="Theo dõi phản ánh từ người dùng, kiểm tra sản phẩm và chủ sở hữu trước khi quyết định hướng xử lý."
      />

      <section className="air-stat-row">
        <div className="air-stat-card">
          <span>Tổng báo cáo</span>
          <strong>{Number(pagination.totalItems || 0).toLocaleString('vi-VN')}</strong>
        </div>
        <div className="air-stat-card">
          <span>Chờ xử lý</span>
          <strong>{reportStats.pending.toLocaleString('vi-VN')}</strong>
        </div>
        <div className="air-stat-card">
          <span>Đã xử lý</span>
          <strong>{reportStats.resolved.toLocaleString('vi-VN')}</strong>
        </div>
        <div className="air-stat-card">
          <span>Không xử lý thêm</span>
          <strong>{reportStats.noAction.toLocaleString('vi-VN')}</strong>
        </div>
      </section>

      <section className="aip-filter-panel">
        <div className="air-filter-form">
          <div className="aip-field">
            <label className="aip-label">Trạng thái</label>
            <CustomSelect
              variant="compact"
              value={status}
              onChange={(val) => changeStatus(val)}
              options={STATUS_OPTIONS}
              ariaLabel="Lọc trạng thái báo cáo"
            />
          </div>
          <div className="aip-field">
            <label className="aip-label">Sắp xếp</label>
            <CustomSelect
              variant="compact"
              value={sort}
              onChange={(val) => setSort(val)}
              options={SORT_OPTIONS}
              ariaLabel="Sắp xếp báo cáo"
            />
          </div>
          <button type="button" className="aip-btn aip-btn--ghost air-refresh-btn" onClick={fetchReports}>
            <i className="fas fa-sync-alt" /> Làm mới
          </button>
        </div>
      </section>

      <section className="aip-table-panel">
        <div className="aip-table-head">
          <div>
            <h3 className="aip-table-title">Danh sách báo cáo</h3>
            <span className="aip-table-count">{Number(pagination.totalItems || 0).toLocaleString('vi-VN')} báo cáo</span>
          </div>
        </div>

        {loading ? (
          <div className="aip-loading"><Spinner /></div>
        ) : (
          <>
            <div className="aip-table-wrap">
              <table className="aip-table air-table">
                <thead>
                  <tr>
                    <th>Báo cáo</th>
                    <th>Sản phẩm</th>
                    <th>Chủ sở hữu</th>
                    <th>Người báo cáo</th>
                    <th>Trạng thái</th>
                    <th>Hướng xử lý</th>
                    <th className="text-end">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleReports.map((report) => {
                    const item = report.itemId || {};
                    const owner = item.ownerId || {};
                    const isResolved = report.status === 'resolved';
                    return (
                      <tr key={report._id}>
                        <td>
                          <div className="air-report-reason">
                            <strong>{report.reason || 'Không có lý do'}</strong>
                            <span>{formatDateTime(report.createdAt)}</span>
                            {report.evidenceImages && report.evidenceImages.length > 0 && (
                              <div className="air-report-evidence d-flex gap-2 mt-2 flex-wrap">
                                {report.evidenceImages.map((img, index) => (
                                  <a
                                    key={index}
                                    href={img}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="air-evidence-thumb-link"
                                    title="Click để phóng to ảnh"
                                  >
                                    <img
                                      src={img}
                                      alt={`Evidence ${index + 1}`}
                                      style={{
                                        width: '45px',
                                        height: '45px',
                                        objectFit: 'cover',
                                        borderRadius: '6px',
                                        border: '1px solid #cbd5e1',
                                        transition: 'transform 0.15s ease',
                                        cursor: 'zoom-in'
                                      }}
                                      onMouseOver={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                                      onMouseOut={(e) => e.currentTarget.style.transform = 'scale(1)'}
                                    />
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="aip-entity">
                            <img src={getItemImage(item)} alt={item.name || 'Sản phẩm'} />
                            <div>
                              <Link to={`/admin/items/${getId(item)}`} className="air-item-link">
                                {item.name || 'Sản phẩm không rõ'}
                              </Link>
                              <span>
                                {formatItemCode(item)} · {itemStatusLabels[item.status] || item.status || '-'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <strong>{getName(owner, '-')}</strong>
                          <span className="aip-muted">{owner.email || '-'}</span>
                        </td>
                        <td>
                          <strong>{getName(report.reporterId, '-')}</strong>
                          <span className="aip-muted">{report.reporterId?.email || '-'}</span>
                        </td>
                        <td>
                          <span className={`aip-pill ${REPORT_STATUS_CLASSES[report.status] || ''}`}>
                            {REPORT_STATUS_LABELS[report.status] || report.status || '-'}
                          </span>
                        </td>
                        <td>
                          <span className={`aip-pill ${report.action ? 'aip-pill--muted' : 'air-pill--waiting'}`}>
                            {ACTION_LABELS[report.action] || 'Chưa có'}
                          </span>
                        </td>
                        <td className="text-end">
                          <div className="aip-actions">
                            <button
                              type="button"
                              className="aip-action-btn aip-action-btn--approve"
                              disabled={actionLoading === report._id}
                              onClick={() => handleQuickDismiss(report)}
                              title="Bỏ qua nhanh (Không vi phạm)"
                            >
                              <i className="fas fa-check-circle" />
                            </button>
                            <button
                              type="button"
                              className="aip-action-btn aip-action-btn--view"
                              disabled={actionLoading === report._id}
                              onClick={() => handleResolve(report)}
                              title={isResolved ? 'Điều chỉnh phán quyết' : 'Xử lý báo cáo'}
                            >
                              <i className={`fas ${isResolved ? 'fa-check' : 'fa-gavel'}`} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visibleReports.length === 0 && (
                <div className="aip-empty">
                  <i className="fas fa-flag" />
                  <p>Không có báo cáo sản phẩm phù hợp với bộ lọc.</p>
                </div>
              )}
            </div>

            <div className="aip-pagination">
              <button
                type="button"
                className="aip-page-btn"
                disabled={(pagination.currentPage || 1) <= 1}
                onClick={() => setPage((pagination.currentPage || 1) - 1)}
              >
                <i className="fas fa-chevron-left" /> Trước
              </button>
              <span className="aip-page-info">
                Trang <strong>{pagination.currentPage || 1}</strong> / {pagination.totalPages || 1}
              </span>
              <button
                type="button"
                className="aip-page-btn"
                disabled={!pagination.hasMore}
                onClick={() => setPage((pagination.currentPage || 1) + 1)}
              >
                Sau <i className="fas fa-chevron-right" />
              </button>
            </div>
          </>
        )}
      </section>

      {resolveModal && (
        <div
          className="modal show d-block"
          tabIndex="-1"
          role="dialog"
          style={{ backgroundColor: 'rgba(15, 23, 42, 0.55)', zIndex: 1050 }}
          onClick={handleCloseResolveModal}
        >
          <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content border-0 shadow-lg" style={{ borderRadius: '16px' }}>
              <div className="modal-header border-bottom">
                <h5 className="modal-title fw-bold">
                  {resolveModal.mode === 'adjust_status'
                    ? 'Điều chỉnh trạng thái sản phẩm'
                    : 'Xử lý báo cáo sản phẩm'}
                </h5>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Đóng"
                  disabled={Boolean(actionLoading)}
                  onClick={handleCloseResolveModal}
                />
              </div>

              <form onSubmit={handleSubmitResolveModal}>
                <div className="modal-body">
                  {resolveModal.mode === 'adjust_status' && (
                    <div
                      className="mb-3 p-3 rounded-3"
                      style={{ background: '#f1f5f9', fontSize: '0.88rem', color: '#475569' }}
                    >
                      <p className="mb-1">
                        <strong>Lưu ý:</strong> Phán quyết ban đầu{' '}
                        <strong>&ldquo;{resolveModal.originalActionLabel}&rdquo;</strong> và các hình phạt liên quan đến chủ sở hữu vẫn được giữ nguyên.
                      </p>
                      <p className="mb-0">
                        Bạn chỉ đang điều chỉnh trạng thái hiển thị của sản phẩm này trên hệ thống.
                      </p>
                    </div>
                  )}

                  <div className="mb-3">
                    <label className="form-label fw-semibold">
                      {resolveModal.mode === 'adjust_status'
                        ? 'Trạng thái sản phẩm'
                        : 'Hướng xử lý'}
                    </label>
                    <CustomSelect
                      value={resolveModal.selectedValue}
                      onChange={(val) =>
                        setResolveModal((prev) => (prev ? { ...prev, selectedValue: val } : prev))
                      }
                      options={
                        resolveModal.mode === 'adjust_status'
                          ? ADJUST_ITEM_STATUS_OPTIONS
                          : ACTION_OPTIONS
                      }
                      disabled={Boolean(actionLoading)}
                      ariaLabel={
                        resolveModal.mode === 'adjust_status'
                          ? 'Trạng thái sản phẩm'
                          : 'Hướng xử lý'
                      }
                    />
                  </div>

                  <div>
                    <label className="form-label fw-semibold">
                      {resolveModal.mode === 'adjust_status'
                        ? 'Lý do điều chỉnh'
                        : 'Ghi chú xử lý'}
                      <span className="text-danger ms-1">*</span>
                    </label>
                    <textarea
                      className={`form-control ${modalValidationError ? 'is-invalid' : ''}`}
                      rows="4"
                      placeholder={
                        resolveModal.mode === 'adjust_status'
                          ? 'Nhập lý do điều chỉnh trạng thái sản phẩm...'
                          : 'Nhập ghi chú xử lý bắt buộc...'
                      }
                      value={resolveModal.note}
                      disabled={Boolean(actionLoading)}
                      onChange={(e) => {
                        setResolveModal((prev) => (prev ? { ...prev, note: e.target.value } : prev));
                        if (modalValidationError) setModalValidationError('');
                      }}
                    />
                    {modalValidationError && (
                      <div className="invalid-feedback d-block">{modalValidationError}</div>
                    )}
                  </div>
                </div>

                <div className="modal-footer border-top">
                  <button
                    type="button"
                    className="btn btn-light rounded-pill px-4"
                    disabled={Boolean(actionLoading)}
                    onClick={handleCloseResolveModal}
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary rounded-pill px-4"
                    disabled={Boolean(actionLoading)}
                  >
                    {actionLoading
                      ? 'Đang xử lý...'
                      : resolveModal.mode === 'adjust_status'
                        ? 'Cập nhật'
                        : 'Xử lý'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
